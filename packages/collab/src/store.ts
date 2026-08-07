import { LoroDoc, type LoroTree, type LoroTreeNode, type TreeID } from 'loro-crdt';
import type { Block, BlockId, BlockStore } from '@nbe/core';
import { LoroText, applyRuns, textToRuns } from './text';
import { MARKS } from '@nbe/core';

/**
 * A document store backed by a CRDT (phase 5).
 *
 * @remarks
 * The audit (`docs/research/crdt-loro-audit.md`) settled the shape: the CRDT is
 * **the document**, not a transport beside it. A CRDT that is not the source of
 * truth is a cache of a truth nobody owns.
 *
 * **The tree owns the structure, and nothing else holds a copy.** A `Block`
 * carries `children` and `parentId`, and so does `LoroTree` — storing both
 * would be the same fact in two places, which is how they come to disagree.
 * So `get` *derives* those two fields from the tree on the way out, and `set`
 * *applies* them to the tree on the way in. Only the value fields — type,
 * version, props, text — are stored, in a map on each node.
 *
 * That derivation is why a move is a move: `set` compares the block's parent
 * against the tree's and calls `LoroTreeNode.move`, which is the operation §3
 * chose `moveBlock` to be. Two clients moving the same block converge instead
 * of duplicating it, which is the whole reason for choosing a movable tree.
 *
 * **Text is a container, not a value** (`text.ts`). Stored as a value, two
 * people editing one paragraph conflict on the whole paragraph and a sentence
 * disappears; as a `LoroText` they merge by position. The store is handed a
 * finished run array rather than an operation, so it diffs — a keystroke
 * becomes one insert at one position, which is the operation Loro wants,
 * recovered from the value we were given.
 *
 * @category Collaboration
 */

export class LoroBlockStore implements BlockStore {
  readonly doc: LoroDoc;
  private readonly tree: LoroTree;
  /** Our ids to Loro's, derived from the tree and rebuilt on import. */
  private index = new Map<BlockId, TreeID>();

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc;
    this.tree = doc.getTree('blocks');
    /*
     * Mark expansion, from the single registry `core` declares (§2.2). Loro
     * takes exactly this shape because both follow Peritext — feeding it from
     * `MARKS` rather than restating it here is what keeps the two honest.
     */
    doc.configTextStyle(
      Object.fromEntries(MARKS.map((mark) => [mark.type, { expand: mark.expand }])) as Parameters<
        LoroDoc['configTextStyle']
      >[0],
    );
    this.reindex();
  }

  /** Rebuild the id mapping from the tree — after an import, or on load. */
  reindex(): void {
    this.index = new Map();
    for (const node of this.tree.nodes()) {
      const id = node.data.get('id');
      if (typeof id === 'string') this.index.set(id, node.id);
    }
  }

  private nodeOf(id: BlockId): LoroTreeNode | undefined {
    const treeId = this.index.get(id);
    if (!treeId) return undefined;
    try {
      return this.tree.getNodeByID(treeId) ?? undefined;
    } catch {
      return undefined; // deleted under us
    }
  }

  /** The block id of a tree node, or null for one we did not write. */
  private idOf(node: LoroTreeNode): BlockId | null {
    try {
      const id = node.data.get('id');
      return typeof id === 'string' ? id : null;
    } catch {
      // a root node's `parent()` hands back a sentinel rather than nothing,
      // and reading its data throws — that is "no parent", not a failure
      return null;
    }
  }

  /** A node's real parent, or null. */
  private parentOf(node: LoroTreeNode): LoroTreeNode | null {
    try {
      return node.parent() ?? null;
    } catch {
      return null;
    }
  }

  private toBlock(node: LoroTreeNode): Block {
    const data = node.data;
    const parent = this.parentOf(node);
    const children = (node.children() ?? [])
      .map((child) => this.idOf(child))
      .filter((id): id is BlockId => id !== null);
    return {
      id: data.get('id') as BlockId,
      type: data.get('type') as string,
      version: data.get('version') as number,
      props: (data.get('props') ?? {}) as Record<string, unknown>,
      // derived, never stored: the tree is the only place structure lives
      children,
      parentId: parent ? this.idOf(parent) : null,
      ...(this.hasText(node) ? { text: textToRuns(this.textOf(node)) } : {}),
    };
  }

  private hasText(node: LoroTreeNode): boolean {
    return node.data.get('text') !== undefined;
  }

  /** The node's text container, created on first use. */
  private textOf(node: LoroTreeNode): LoroText {
    const existing = node.data.get('text');
    if (existing instanceof LoroText) return existing;
    return node.data.setContainer('text', new LoroText());
  }

  get(id: BlockId): Block | undefined {
    const node = this.nodeOf(id);
    return node ? this.toBlock(node) : undefined;
  }

  has(id: BlockId): boolean {
    return this.nodeOf(id) !== undefined;
  }

  set(id: BlockId, block: Block): void {
    const node = this.ensure(id, block.parentId);
    const data = node.data;
    data.set('id', id);
    data.set('type', block.type);
    data.set('version', block.version);
    data.set('props', block.props as never);
    if (block.text !== undefined) applyRuns(this.textOf(node), block.text);
    else if (data.get('text') !== undefined) data.delete('text');

    this.applyParent(node, block.parentId);
    this.applyChildren(node, block.children ?? []);
    /*
     * Loro batches until a commit, and the change subscription only fires on
     * one. Without this the document is correct locally and nothing is ever
     * sent — sync appeared to work on connect and then went quiet.
     */
    this.doc.commit();
  }

  /** The node for `id`, created under `parentId` if it is not there yet. */
  private ensure(id: BlockId, parentId: BlockId | null): LoroTreeNode {
    const existing = this.nodeOf(id);
    if (existing) return existing;
    const parent = parentId === null ? undefined : this.nodeOf(parentId);
    const node = parent ? parent.createNode() : this.tree.createNode();
    node.data.set('id', id);
    this.index.set(id, node.id);
    return node;
  }

  /** Move the node if the block says it belongs somewhere else. */
  private applyParent(node: LoroTreeNode, parentId: BlockId | null): void {
    const current = this.parentOf(node);
    const currentId = current ? this.idOf(current) : null;
    if (currentId === parentId) return;
    if (parentId === null) {
      node.move(undefined);
      return;
    }
    const parent = this.nodeOf(parentId);
    if (parent) node.move(parent);
  }

  /**
   * Put this node's children in the order the block lists.
   *
   * @remarks
   * Only the listed ones are touched. The reducer removes a child from its
   * parent's array *before* deleting the child's own block, so a node that is
   * about to go is briefly present and unlisted — reordering must not mistake
   * that for a move, and deletion arrives a moment later.
   */
  private applyChildren(node: LoroTreeNode, children: readonly BlockId[]): void {
    children.forEach((childId, index) => {
      const child = this.nodeOf(childId);
      if (!child) return;
      const siblings = (node.children() ?? []).map((sibling) => this.idOf(sibling));
      if (siblings[index] === childId) return;
      /*
       * Clamped: the block lists its children in final order, but they arrive
       * one at a time, so the wanted index can be past the end of what the
       * tree holds so far. Loro refuses that outright rather than appending,
       * and the next child's placement corrects the order anyway.
       */
      const alreadyHere = this.parentOf(child)?.id === node.id;
      const at = Math.min(index, alreadyHere ? siblings.length - 1 : siblings.length);
      child.move(node, Math.max(0, at));
    });
  }

  delete(id: BlockId): boolean {
    const node = this.nodeOf(id);
    if (!node) return false;
    this.tree.delete(node.id);
    this.index.delete(id);
    this.doc.commit();
    return true;
  }

  *values(): IterableIterator<Block> {
    for (const node of this.tree.nodes()) {
      if (this.idOf(node) !== null) yield this.toBlock(node);
    }
  }

  get size(): number {
    return this.index.size;
  }

  /** Everything since `from`, as an opaque blob for a peer. */
  export(from?: Uint8Array): Uint8Array {
    return from
      ? this.doc.export({ mode: 'update', from: this.doc.frontiersToVV(this.doc.frontiers()) })
      : this.doc.export({ mode: 'snapshot' });
  }

  /** Apply a peer's blob. The id index is derived, so it is rebuilt after. */
  import(update: Uint8Array): void {
    this.doc.import(update);
    this.reindex();
  }
}

export { LoroDoc };
