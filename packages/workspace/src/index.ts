import { plainText, uuidv7, type BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from './storage';

export { memoryStorage, type WorkspaceStorage } from './storage';

/**
 * The notes application's model: a tree of pages over a storage seam.
 *
 * @remarks
 * ROADMAP phase 4. What existed before this was an **embeddable editor** and a
 * demo whose workspace was `pages: BlockJSON[]` — a flat array. There was no
 * page tree in the project at all, which is why phase 4 is an application
 * layer rather than a storage one.
 *
 * **Where the tree lives, and why it is derived.** Three commitments in
 * `docs/ARCHITECTURE.md` have to hold at once:
 *
 * - §2.2 — one nested JSON tree *per page* at rest. So a child page cannot be
 *   stored inside its parent's document; it is its own document.
 * - §2.4 — a sub-page, a link-to-page and an inline mention are three distinct
 *   constructs, never conflated. So nesting is not "a link that happens to
 *   point down".
 * - §10 — the derived index holds **zero unique information** and is
 *   rebuildable by a full scan of L0.
 *
 * Together those force one answer: the parent's document carries a
 * `sub_page` block naming its child, and the navigable tree is *computed* from
 * those blocks. Nothing here is authoritative. Delete the index, scan again,
 * get the same tree — which is also what makes "delete the app, read the
 * files" achievable rather than aspirational.
 *
 * The cost is honest and bounded: building the index reads every page once.
 * At the scale a person's notes actually reach that is milliseconds, and the
 * alternative — a stored `parentId` — is a second source of truth that can
 * disagree with the documents. When it stops being milliseconds, the fix is to
 * cache this index, not to make it authoritative.
 *
 * @category Workspace
 */

/** The block type that nests one page under another (§2.4). */
export const SUB_PAGE = 'sub_page';

/** A page's identity and place in the tree. Never its content. */
export interface PageNode {
  id: string;
  /** Derived from the document: its first non-empty text, else `props.title`. */
  title: string;
  parentId: string | null;
  /** Child pages, in the order their `sub_page` blocks appear in the parent. */
  children: string[];
}

export interface SearchHit {
  pageId: string;
  title: string;
  /** The matching text, with a little context around it. */
  snippet: string;
}

/** Where a reference to a page was found. */
export type ReferenceKind = 'sub_page' | 'link_to_page' | 'mention';

export interface Backlink {
  /** The page the reference was found in. */
  pageId: string;
  title: string;
  kind: ReferenceKind;
}

/** Every block in a document, parents before children. */
function* walk(block: BlockJSON): Generator<BlockJSON> {
  yield block;
  for (const child of block.children ?? []) yield* walk(child);
}

/** The page a block points at, and how, or null if it points nowhere. */
function reference(block: BlockJSON): { id: string; kind: ReferenceKind } | null {
  const id = String(block.props?.['pageId'] ?? '');
  if (!id) return null;
  if (block.type === SUB_PAGE) return { id, kind: 'sub_page' };
  if (block.type === 'link_to_page') return { id, kind: 'link_to_page' };
  return null;
}

/** Page ids mentioned inline, from mark attributes rather than block props. */
function* mentioned(block: BlockJSON): Generator<string> {
  for (const run of block.text ?? []) {
    for (const mark of run.marks ?? []) {
      const id = String(mark.attrs?.['pageId'] ?? '');
      if (mark.type === 'mention' && id) yield id;
    }
  }
}

/**
 * Every asset a set of pages refers to.
 *
 * @remarks
 * Binary content is stored by content hash and referred to by an opaque
 * `asset:<hash>` string (AQ#2), which can appear in any block prop — an
 * image's `src`, a file block's target, a callout's custom icon — and in a
 * mark's attributes. So this looks at *values*, not at a list of the props
 * that are allowed to hold one. A block type added later needs no change here,
 * and forgetting to update a list is how a garbage collector deletes something
 * that was in use.
 *
 * This is the mark half of a mark-and-sweep. The sweep belongs to whatever
 * owns the blobs, and the reason it is not reference counting is written in
 * the demo's asset store: counts drift under undo, multiple tabs and crashes,
 * and a wrong count deletes a file someone still has on screen.
 *
 * @category Storage
 */
export function referencedAssets(pages: Iterable<BlockJSON>): Set<string> {
  const found = new Set<string>();
  const take = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('asset:')) found.add(value);
    } else if (Array.isArray(value)) value.forEach(take);
    else if (value && typeof value === 'object') Object.values(value).forEach(take);
  };
  for (const page of pages) {
    for (const block of walk(page)) {
      if (block.props) take(block.props);
      for (const run of block.text ?? []) for (const mark of run.marks ?? []) take(mark.attrs);
    }
  }
  return found;
}

/** A page's display title: what a reader would call it. */
export function pageTitle(page: BlockJSON): string {
  for (const child of page.children ?? []) {
    const text = plainText(child.text).trim();
    if (text) return text.slice(0, 80);
  }
  return String(page.props?.['title'] ?? '').trim() || 'Sans titre';
}

/** A fresh page document: a heading carrying its title, and somewhere to type. */
export function newPage(title = ''): BlockJSON {
  return {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: { title },
    children: [
      { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: title ? [{ text: title }] : [] },
      { id: uuidv7(), type: 'paragraph', version: 1, text: [] },
    ],
  };
}

/**
 * A tree of pages over a storage adapter.
 *
 * @remarks
 * The notes application's model. Load it, and the tree is derived from the
 * `sub_page` blocks inside each page — nothing about the hierarchy is stored
 * beside the documents, so a workspace rebuilt from a folder of files is the
 * same workspace.
 *
 * @example
 * ```ts
 * import { Workspace, memoryStorage } from '@nbe/workspace'
 *
 * const workspace = new Workspace(memoryStorage())
 * await workspace.load()
 * const projects = await workspace.createPage({ title: 'Projets' })
 * await workspace.createPage({ parentId: projects, title: 'Éditeur' })
 * workspace.node(projects)?.children // → [the child's id]
 * ```
 *
 * @category Workspace
 */
export class Workspace {
  private docs = new Map<string, BlockJSON>();
  private nodes = new Map<string, PageNode>();
  private rootIds: string[] = [];

  constructor(private readonly storage: WorkspaceStorage) {}

  /**
   * Read every page and build the tree. Safe to call again at any time.
   *
   * @remarks
   * Loaded into a fresh map and swapped in at the end, never emptied in place.
   * Clearing first leaves the workspace *empty across an await* — and anything
   * that renders during that window draws nothing. Measured: a database table
   * re-rendered mid-load and showed zero rows over rows that existed, which
   * looked exactly like data loss.
   */
  async load(): Promise<void> {
    const loaded = new Map<string, BlockJSON>();
    for (const id of await this.storage.list()) {
      const doc = await this.storage.read(id);
      if (doc) loaded.set(id, doc);
    }
    this.docs = loaded;
    this.reindex();
  }

  /** Top-level pages, in creation order. */
  get roots(): readonly string[] {
    return this.rootIds;
  }

  /** Every page, unordered. */
  get pages(): readonly PageNode[] {
    return [...this.nodes.values()];
  }

  node(id: string): PageNode | undefined {
    return this.nodes.get(id);
  }

  /** A page's document, or `null`. The caller may mutate what it gets. */
  document(id: string): BlockJSON | null {
    const doc = this.docs.get(id);
    return doc ? (JSON.parse(JSON.stringify(doc)) as BlockJSON) : null;
  }

  /** Persist an edited document and refresh the tree it may have changed. */
  async save(id: string, doc: BlockJSON): Promise<void> {
    this.docs.set(id, doc);
    await this.storage.write(id, doc);
    this.reindex();
  }

  /** The path from a root down to `id`, inclusive — a breadcrumb. */
  path(id: string): PageNode[] {
    const out: PageNode[] = [];
    let current = this.nodes.get(id);
    // the depth cap is a corrupt-store guard: a cycle must not hang the app
    for (let depth = 0; current && depth < 100; depth++) {
      out.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return out;
  }

  /**
   * Create a page, optionally under another.
   *
   * @remarks
   * Two writes, and they are not interchangeable: the child document, then the
   * parent's `sub_page` block. In that order, a crash between them leaves an
   * unreferenced page — which the next scan surfaces as a root, so nothing is
   * lost. The other order would leave the parent pointing at a page that does
   * not exist.
   */
  async createPage(opts: { parentId?: string | null; title?: string; index?: number } = {}): Promise<string> {
    const doc = newPage(opts.title ?? '');
    await this.storage.write(doc.id, doc);
    this.docs.set(doc.id, doc);

    const parentId = opts.parentId ?? null;
    if (parentId && this.docs.has(parentId)) {
      await this.insertRef(parentId, doc.id, opts.title ?? '', opts.index);
    }
    this.reindex();
    return doc.id;
  }

  /**
   * Move a page under a new parent, at an optional position.
   *
   * @remarks
   * Refuses to move a page into its own subtree, which would detach that whole
   * branch from every root and make it unreachable — the tree equivalent of
   * dropping a folder into itself.
   */
  async movePage(id: string, parentId: string | null, index?: number): Promise<boolean> {
    if (!this.nodes.has(id)) return false;
    if (parentId !== null) {
      if (!this.nodes.has(parentId)) return false;
      if (parentId === id || this.path(parentId).some((n) => n.id === id)) return false;
    }
    const from = this.nodes.get(id)!.parentId;
    if (from) await this.removeRef(from, id);
    if (parentId) await this.insertRef(parentId, id, this.nodes.get(id)!.title, index);
    this.reindex();
    return true;
  }

  /** Retitle a page: its heading, its `title` prop, and its parent's reference. */
  async renamePage(id: string, title: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc) return;
    doc.props = { ...doc.props, title };
    const heading = (doc.children ?? []).find((c) => c.type === 'heading');
    if (heading) heading.text = title ? [{ text: title }] : [];
    await this.storage.write(id, doc);

    const parentId = this.nodes.get(id)?.parentId;
    if (parentId) {
      const parent = this.docs.get(parentId);
      const ref = parent && [...walk(parent)].find((b) => b.type === SUB_PAGE && b.props?.['pageId'] === id);
      if (parent && ref) {
        ref.props = { ...ref.props, title };
        await this.storage.write(parentId, parent);
      }
    }
    this.reindex();
  }

  /**
   * Delete a page and everything under it.
   *
   * @returns Every id removed, deepest first — enough to undo, and enough for
   * a caller to tell the user what actually went.
   */
  async deletePage(id: string): Promise<string[]> {
    const node = this.nodes.get(id);
    if (!node) return [];
    const removed: string[] = [];
    const collect = (pageId: string) => {
      for (const child of this.nodes.get(pageId)?.children ?? []) collect(child);
      removed.push(pageId);
    };
    collect(id);

    if (node.parentId) await this.removeRef(node.parentId, id);
    for (const pageId of removed) {
      await this.storage.remove(pageId);
      this.docs.delete(pageId);
    }
    this.reindex();
    return removed;
  }

  /**
   * Pages whose text contains `query`.
   *
   * @remarks
   * A linear scan with a case- and accent-insensitive compare. That is the
   * right amount of machinery for a personal workspace, and §10 is explicit
   * that the real index is per-runtime — FTS5 on a backend, and nothing at all
   * in the browser until a measurement says otherwise.
   */
  search(query: string): SearchHit[] {
    const needle = fold(query);
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (const [id, doc] of this.docs) {
      for (const block of walk(doc)) {
        const text = plainText(block.text);
        const at = fold(text).indexOf(needle);
        if (at < 0) continue;
        hits.push({
          pageId: id,
          title: this.nodes.get(id)?.title ?? pageTitle(doc),
          snippet: snippetAround(text, at, query.length),
        });
        break; // one hit per page: this is navigation, not a concordance
      }
    }
    return hits;
  }

  /**
   * Pages that reference `id`.
   *
   * @remarks
   * Derived, never authored — §2.4. All three reference kinds count, and the
   * kind comes back with the hit because they mean different things to a
   * reader: a sub-page is where the page *lives*, the other two are where it
   * is *talked about*.
   */
  backlinks(id: string): Backlink[] {
    const out: Backlink[] = [];
    for (const [pageId, doc] of this.docs) {
      if (pageId === id) continue;
      const kinds = new Set<ReferenceKind>();
      for (const block of walk(doc)) {
        const ref = reference(block);
        if (ref?.id === id) kinds.add(ref.kind);
        for (const target of mentioned(block)) if (target === id) kinds.add('mention');
      }
      for (const kind of kinds) {
        out.push({ pageId, title: this.nodes.get(pageId)?.title ?? pageTitle(doc), kind });
      }
    }
    return out;
  }

  // --- the index -----------------------------------------------------------

  /**
   * Rebuild the tree from the documents.
   *
   * @remarks
   * Defensive by construction, because a store can be corrupt in ways the app
   * must survive: a page claimed by two parents keeps its first claim, a
   * reference to a missing page is ignored, and a cycle is broken by the same
   * first-claim rule plus the depth cap in {@link path}. The result is always
   * a forest — never a graph, never an infinite loop.
   */
  private reindex(): void {
    this.nodes.clear();
    for (const [id, doc] of this.docs) {
      this.nodes.set(id, { id, title: pageTitle(doc), parentId: null, children: [] });
    }
    const claimed = new Set<string>();
    for (const [parentId, doc] of this.docs) {
      for (const block of walk(doc)) {
        const ref = reference(block);
        if (ref?.kind !== 'sub_page') continue;
        const child = this.nodes.get(ref.id);
        if (!child || claimed.has(ref.id) || ref.id === parentId) continue;
        claimed.add(ref.id);
        child.parentId = parentId;
        this.nodes.get(parentId)!.children.push(ref.id);
      }
    }
    // a cycle claims every page in it, so it would vanish from the forest;
    // detach the ones that cannot reach a root and let them stand as roots
    for (const node of this.nodes.values()) {
      let cursor: PageNode | undefined = node;
      for (let depth = 0; cursor?.parentId && depth < 100; depth++) {
        cursor = this.nodes.get(cursor.parentId);
      }
      if (cursor?.parentId) {
        this.nodes.get(cursor.parentId)!.children = this.nodes
          .get(cursor.parentId)!
          .children.filter((c) => c !== cursor!.id);
        cursor.parentId = null;
      }
    }
    this.rootIds = [...this.nodes.values()].filter((n) => n.parentId === null).map((n) => n.id).sort();
  }

  private async insertRef(parentId: string, childId: string, title: string, index?: number): Promise<void> {
    const parent = this.docs.get(parentId);
    if (!parent) return;
    const block: BlockJSON = { id: uuidv7(), type: SUB_PAGE, version: 1, props: { pageId: childId, title } };
    const children = (parent.children ??= []);
    children.splice(index ?? children.length, 0, block);
    await this.storage.write(parentId, parent);
  }

  private async removeRef(parentId: string, childId: string): Promise<void> {
    const parent = this.docs.get(parentId);
    if (!parent) return;
    const prune = (block: BlockJSON): void => {
      if (!block.children) return;
      block.children = block.children.filter(
        (c) => !(c.type === SUB_PAGE && c.props?.['pageId'] === childId),
      );
      for (const child of block.children) prune(child);
    };
    prune(parent);
    await this.storage.write(parentId, parent);
  }
}

/** Case- and accent-insensitive, so "reunion" finds "réunion". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + length + 30);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
