import type { Block, BlockId } from './types';
import { uuidv7 } from './id';

export interface Doc {
  blocks: Map<BlockId, Block>;
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

export function docFromJSON(json: BlockJSON): Doc {
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
