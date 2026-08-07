import type { Block, BlockId } from './types';
import type { Schema } from './schema';
import { migrateJSON, type MigrationReport } from './migrate';
import { uuidv7 } from './id';

/**
 * Where a document's blocks live.
 *
 * @remarks
 * An interface rather than a `Map`, and the distinction is the whole of what
 * phase 5 needs from `core` (`docs/research/crdt-loro-audit.md`). The roadmap
 * has always said a CRDT would sit "behind the same store interface the
 * plain-JSON implementation satisfies" — there was no interface, and every
 * command read a `Map` directly.
 *
 * The methods are exactly the ones the codebase uses, which is why `Map`
 * satisfies this structurally and all fifty-odd call sites are unchanged. A
 * store backed by a CRDT, or a lazy one that materialises blocks on demand for
 * a very large document, implements the same six members.
 *
 * **The contract is that a store never has to hand out its own objects.** The
 * reducer mutates what `get` returns and then calls `set` — so a store that
 * materialises a fresh block on every read, as a CRDT-backed one must, still
 * sees every edit. That was not true when this interface was first declared,
 * and declaring it did not make it true: `applyOp` mutated in place and relied
 * on `Map` handing back its own object. `test/block-store.test.ts` drives an
 * editor against a store that returns copies, which fails on any missing
 * write-back.
 *
 * Deliberately *not* an abstraction over how blocks are shaped, ordered or
 * validated: those are the reducer's business, and a store that knew about
 * them would be a second model.
 *
 * @category Document
 */
export interface BlockStore {
  get(id: BlockId): Block | undefined;
  has(id: BlockId): boolean;
  set(id: BlockId, block: Block): void;
  delete(id: BlockId): boolean;
  values(): IterableIterator<Block>;
  readonly size: number;
}

export interface Doc {
  blocks: BlockStore;
  rootId: BlockId;
}

export function createDoc(): Doc {
  const root: Block = {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: {},
    children: [],
    parentId: null,
  };
  return { blocks: new Map([[root.id, root]]), rootId: root.id };
}

export function getBlock(doc: Doc, id: BlockId): Block {
  const b = doc.blocks.get(id);
  if (!b) throw new Error(`Block not found: ${id}`);
  return b;
}

export function childIndex(doc: Doc, id: BlockId): number {
  const b = getBlock(doc, id);
  if (b.parentId === null) return -1;
  return getBlock(doc, b.parentId).children.indexOf(id);
}

function isExpanded(b: Block): boolean {
  return b.props['collapsed'] !== true;
}

/** Depth-first order of visible blocks (collapsed toggles hide their children). */
export function visibleBlocks(doc: Doc): Block[] {
  const out: Block[] = [];
  // seen-set: a corrupted children cycle degrades to a truncated list,
  // never an infinite walk (defense-in-depth; move_block forbids cycles)
  const seen = new Set<BlockId>();
  const walk = (id: BlockId) => {
    if (seen.has(id)) return;
    seen.add(id);
    const b = doc.blocks.get(id);
    if (!b) return;
    if (id !== doc.rootId) out.push(b);
    if (id === doc.rootId || isExpanded(b)) for (const c of b.children) walk(c);
  };
  walk(doc.rootId);
  return out;
}

/** Bounded parentId walk; returns the ancestor chain (nearest first). */
export function ancestors(doc: Doc, id: BlockId): BlockId[] {
  const out: BlockId[] = [];
  let p = doc.blocks.get(id)?.parentId ?? null;
  for (let depth = 0; p !== null && depth < 500; depth++) {
    out.push(p);
    p = doc.blocks.get(p)?.parentId ?? null;
  }
  return out;
}

export function previousInlineBlock(doc: Doc, id: BlockId, inlineOf: (b: Block) => boolean): Block | null {
  const order = visibleBlocks(doc).filter(inlineOf);
  const i = order.findIndex((b) => b.id === id);
  return i > 0 ? order[i - 1]! : null;
}

export function nextInlineBlock(doc: Doc, id: BlockId, inlineOf: (b: Block) => boolean): Block | null {
  const order = visibleBlocks(doc).filter(inlineOf);
  const i = order.findIndex((b) => b.id === id);
  return i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
}

// --- at-rest serialization: nested JSON tree per page (ARCHITECTURE §2.1, D5) ---

export interface BlockJSON {
  id: BlockId;
  type: string;
  version: number;
  props?: Record<string, unknown>;
  text?: Block['text'];
  children?: BlockJSON[];
}

export function blockToJSON(doc: Doc, id: BlockId, seen: Set<BlockId> = new Set()): BlockJSON {
  const b = getBlock(doc, id);
  seen.add(id);
  const json: BlockJSON = { id: b.id, type: b.type, version: b.version };
  if (Object.keys(b.props).length) json.props = b.props;
  if (b.text?.length) json.text = b.text;
  const kids = b.children.filter((c) => doc.blocks.has(c) && !seen.has(c));
  if (kids.length) json.children = kids.map((c) => blockToJSON(doc, c, seen));
  return json;
}

export function docToJSON(doc: Doc): BlockJSON {
  return blockToJSON(doc, doc.rootId);
}

/**
 * Build a document from stored JSON, migrating it when given a schema.
 *
 * @param json - The stored tree.
 * @param opts - Pass `schema` to run migrations at this boundary, and
 * `onReport` to see what was upgraded, left unknown, or came from a newer
 * build than this one.
 *
 * @category Blocks
 */
export function docFromJSON(
  json: BlockJSON,
  opts: { schema?: Schema; onReport?: (report: MigrationReport) => void } = {},
): Doc {
  if (opts.schema) {
    const { json: upgraded, report } = migrateJSON(json, opts.schema);
    opts.onReport?.(report);
    json = upgraded;
  }
  const blocks = new Map<BlockId, Block>();
  const add = (node: BlockJSON, parentId: BlockId | null) => {
    blocks.set(node.id, {
      id: node.id,
      type: node.type,
      version: node.version,
      props: node.props ?? {},
      text: node.text,
      children: (node.children ?? []).map((c) => c.id),
      parentId,
    });
    for (const c of node.children ?? []) add(c, node.id);
  };
  add(json, null);
  return { blocks, rootId: json.id };
}
