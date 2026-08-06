import type { Block, BlockId, Run, Selection } from './types';
import { isCollapsed, textCaret } from './types';
import { childIndex, getBlock, previousInlineBlock } from './doc';
import { sliceRuns, textLength } from './richtext';
import { hasMark } from './richtext';
import { uuidv7 } from './id';
import type { Editor } from './editor';

function caretOf(sel: Selection): { blockId: BlockId; offset: number } | null {
  if (sel?.kind !== 'text' || !isCollapsed(sel)) return null;
  return sel.anchor;
}

/** Block types where Enter continues the same type instead of a paragraph. */
const CONTINUING_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle']);

/**
 * Enter semantics (ProseMirror-inspired chain, ARCHITECTURE §3):
 * empty non-paragraph → turn into paragraph; else split at the caret.
 */
export function splitBlock(editor: Editor): boolean {
  const caret = caretOf(editor.selection);
  if (!caret) return false;
  const block = getBlock(editor.doc, caret.blockId);
  if (!editor.schema.get(block.type).inline) return false;

  const len = textLength(block.text);
  if (len === 0 && block.type !== 'paragraph') {
    turnInto(editor, block.id, 'paragraph');
    return true;
  }

  const tail = sliceRuns(block.text ?? [], caret.offset, len);
  const newType = CONTINUING_TYPES.has(block.type) ? block.type : 'paragraph';
  const newBlock: Block = {
    id: uuidv7(),
    type: newType,
    version: 1,
    props: newType === 'to_do' ? { checked: false } : {},
    text: tail,
    children: [],
    parentId: block.parentId,
  };
  editor.dispatch(
    (tx) => {
      if (caret.offset < len) tx.op({ type: 'delete_text', id: block.id, from: caret.offset, to: len });
      tx.op({ type: 'insert_block', block: newBlock, index: childIndex(editor.doc, block.id) + 1 });
    },
    { origin: 'input', selection: textCaret(newBlock.id, 0) },
  );
  return true;
}

/**
 * Backspace-at-start semantics: non-paragraph converts to paragraph first
 * (Notion behavior), then paragraph merges into the previous inline block.
 */
export function mergeBackward(editor: Editor): boolean {
  const caret = caretOf(editor.selection);
  if (!caret || caret.offset !== 0) return false;
  const block = getBlock(editor.doc, caret.blockId);
  const spec = editor.schema.get(block.type);
  if (!spec.inline) return false;

  if (block.type !== 'paragraph') {
    turnInto(editor, block.id, 'paragraph');
    return true;
  }

  const prev = previousInlineBlock(editor.doc, block.id, (b) => editor.schema.get(b.type).inline);
  if (!prev) return false;
  const prevLen = textLength(prev.text);
  const runs = block.text ?? [];

  editor.dispatch(
    (tx) => {
      // promote children in place before deleting (delete_block requires a leaf)
      let after: BlockId | null = block.id;
      for (const childId of [...block.children]) {
        tx.op({ type: 'move_block', id: childId, parentId: block.parentId!, after });
        after = childId;
      }
      if (runs.length) tx.op({ type: 'insert_text', id: prev.id, offset: prevLen, runs });
      tx.op({ type: 'delete_block', id: block.id });
    },
    { origin: 'input', selection: textCaret(prev.id, prevLen) },
  );
  return true;
}

export function turnInto(
  editor: Editor,
  id: BlockId,
  type: string,
  props?: Record<string, unknown>,
): void {
  const defaults = editor.schema.get(type).defaultProps;
  // non-destructive: only add defaults for keys the block doesn't have (ARCHITECTURE §2.1)
  const block = getBlock(editor.doc, id);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults ?? {})) if (!(k in block.props)) patch[k] = v;
  Object.assign(patch, props);
  editor.dispatch(
    (tx) =>
      tx.op({
        type: 'update_block',
        id,
        patch: { type, ...(Object.keys(patch).length ? { props: patch } : {}) },
      }),
    { origin: 'input', selection: editor.selection },
  );
}

/** Toggle a mark over the current text selection (single block for now). */
export function toggleMark(editor: Editor, markType: string, attrs?: Record<string, unknown>): boolean {
  const sel = editor.selection;
  if (sel?.kind !== 'text' || sel.anchor.blockId !== sel.head.blockId) return false;
  const from = Math.min(sel.anchor.offset, sel.head.offset);
  const to = Math.max(sel.anchor.offset, sel.head.offset);
  if (from === to) return false;
  const block = getBlock(editor.doc, sel.anchor.blockId);
  const add = !hasMark(block.text ?? [], from, to, markType);
  editor.dispatch(
    (tx) => tx.op({ type: 'format_text', id: block.id, from, to, mark: { type: markType, attrs }, add }),
    { origin: 'format', selection: sel },
  );
  return true;
}

/** Tab: nest the block under its previous sibling (Notion indent). */
export function indent(editor: Editor, id: BlockId): boolean {
  const block = getBlock(editor.doc, id);
  if (block.parentId === null) return false;
  const parent = getBlock(editor.doc, block.parentId);
  const idx = parent.children.indexOf(id);
  if (idx <= 0) return false;
  const prevSibling = getBlock(editor.doc, parent.children[idx - 1]!);
  editor.dispatch(
    (tx) =>
      tx.op({
        type: 'move_block',
        id,
        parentId: prevSibling.id,
        after: prevSibling.children[prevSibling.children.length - 1] ?? null,
      }),
    { origin: 'input', selection: editor.selection },
  );
  return true;
}

/** Shift+Tab: move the block after its parent, one level up. */
export function outdent(editor: Editor, id: BlockId): boolean {
  const block = getBlock(editor.doc, id);
  if (block.parentId === null) return false;
  const parent = getBlock(editor.doc, block.parentId);
  if (parent.parentId === null) return false; // already at page level
  editor.dispatch(
    (tx) => tx.op({ type: 'move_block', id, parentId: parent.parentId!, after: parent.id }),
    { origin: 'input', selection: editor.selection },
  );
  return true;
}

// --- markdown autoformat (ARCHITECTURE §5, Notion's autoformat table) ---

export interface AutoformatRule {
  /** Exact text before the caret that triggers the conversion (space included when space-triggered). */
  prefix: string;
  type: string;
  props?: Record<string, unknown>;
}

export const AUTOFORMAT_RULES: AutoformatRule[] = [
  { prefix: '# ', type: 'heading', props: { level: 1 } },
  { prefix: '## ', type: 'heading', props: { level: 2 } },
  { prefix: '### ', type: 'heading', props: { level: 3 } },
  { prefix: '- ', type: 'bulleted_list_item' },
  { prefix: '* ', type: 'bulleted_list_item' },
  { prefix: '1. ', type: 'numbered_list_item' },
  { prefix: '[] ', type: 'to_do' },
  { prefix: '[x] ', type: 'to_do', props: { checked: true } },
  { prefix: '> ', type: 'toggle' }, // Notion: '>' is toggle, '"' is quote
  { prefix: '" ', type: 'quote' },
  { prefix: '```', type: 'code' },
];

export function matchAutoformat(textBeforeCaret: string): AutoformatRule | null {
  return AUTOFORMAT_RULES.find((r) => r.prefix === textBeforeCaret) ?? null;
}

/** Apply an autoformat rule: strip the prefix and convert the block. */
export function applyAutoformat(editor: Editor, id: BlockId, rule: AutoformatRule): void {
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'delete_text', id, from: 0, to: rule.prefix.length });
      tx.op({
        type: 'update_block',
        id,
        patch: { type: rule.type, ...(rule.props ? { props: rule.props } : {}) },
      });
    },
    { origin: 'input', selection: textCaret(id, 0) },
  );
}

/** '---' becomes a divider with a fresh paragraph after it. */
export function applyDividerAutoformat(editor: Editor, id: BlockId): void {
  const block = getBlock(editor.doc, id);
  const paragraph: Block = {
    id: uuidv7(),
    type: 'paragraph',
    version: 1,
    props: {},
    text: [],
    children: [],
    parentId: block.parentId,
  };
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'delete_text', id, from: 0, to: textLength(block.text) });
      tx.op({ type: 'update_block', id, patch: { type: 'divider' } });
      tx.op({ type: 'insert_block', block: paragraph, index: childIndex(editor.doc, id) + 1 });
    },
    { origin: 'input', selection: textCaret(paragraph.id, 0) },
  );
}

/** Insert a plain-text run at the caret, replacing any selected range first. */
export function insertText(editor: Editor, data: string, marks?: Run['marks']): boolean {
  const sel = editor.selection;
  if (sel?.kind !== 'text' || sel.anchor.blockId !== sel.head.blockId) return false;
  const id = sel.anchor.blockId;
  const from = Math.min(sel.anchor.offset, sel.head.offset);
  const to = Math.max(sel.anchor.offset, sel.head.offset);
  editor.dispatch(
    (tx) => {
      if (from < to) tx.op({ type: 'delete_text', id, from, to });
      tx.op({ type: 'insert_text', id, offset: from, runs: [{ text: data, marks }] });
    },
    { origin: 'input', selection: textCaret(id, from + data.length), coalesce: `typing:${id}` },
  );
  return true;
}

/** Delete the selected range, or one code point backward from the caret. */
export function deleteBackward(editor: Editor): boolean {
  const sel = editor.selection;
  if (sel?.kind !== 'text' || sel.anchor.blockId !== sel.head.blockId) return false;
  const id = sel.anchor.blockId;
  const from = Math.min(sel.anchor.offset, sel.head.offset);
  const to = Math.max(sel.anchor.offset, sel.head.offset);
  if (from !== to) {
    editor.dispatch((tx) => tx.op({ type: 'delete_text', id, from, to }), {
      origin: 'input',
      selection: textCaret(id, from),
    });
    return true;
  }
  if (from === 0) return false; // caller falls through to mergeBackward
  const block = getBlock(editor.doc, id);
  const plain = (block.text ?? []).map((r) => r.text).join('');
  // ponytail: code-point-aware only; grapheme clusters (ZWJ emoji) take several presses — AQ#4
  const prevCode = plain.charCodeAt(from - 1);
  const step = from >= 2 && prevCode >= 0xdc00 && prevCode <= 0xdfff ? 2 : 1;
  editor.dispatch((tx) => tx.op({ type: 'delete_text', id, from: from - step, to: from }), {
    origin: 'input',
    selection: textCaret(id, from - step),
    coalesce: `typing:${id}`,
  });
  return true;
}
