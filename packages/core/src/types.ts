export type BlockId = string;

export interface Mark {
  type: string; // 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link' | 'color'
  attrs?: Record<string, unknown>;
}

export interface Run {
  text: string;
  marks?: Mark[];
}

export interface Block {
  id: BlockId;
  type: string;
  version: number;
  props: Record<string, unknown>;
  /** Inline rich text; present only on blocks whose spec has `inline: true`. */
  text?: Run[];
  children: BlockId[];
  parentId: BlockId | null;
}

/** A position in inline text: (blockId, UTF-16 offset). Never persisted. */
export interface Point {
  blockId: BlockId;
  offset: number;
}

export interface TextSelection {
  kind: 'text';
  anchor: Point;
  head: Point;
}

export interface BlockSelection {
  kind: 'block';
  anchor: BlockId;
  head: BlockId;
}

export type Selection = TextSelection | BlockSelection | null;

export function isCollapsed(sel: TextSelection): boolean {
  return sel.anchor.blockId === sel.head.blockId && sel.anchor.offset === sel.head.offset;
}

export function textCaret(blockId: BlockId, offset: number): TextSelection {
  const p = { blockId, offset };
  return { kind: 'text', anchor: p, head: { ...p } };
}
