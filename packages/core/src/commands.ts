import type { Block, BlockId, BlockSelection, Run, Selection } from './types';
import { prevGrapheme, snapGrapheme } from './grapheme';
import { isCollapsed, textCaret } from './types';
import { ancestors, childIndex, getBlock, previousInlineBlock, visibleBlocks, type Doc } from './doc';
import { plainText, sliceRuns, textLength } from './richtext';
import { hasMark } from './richtext';
import { uuidv7 } from './id';
import type { Editor, Tx } from './editor';
import type { PluginRegistry } from './plugin';

function caretOf(sel: Selection): { blockId: BlockId; offset: number } | null {
  if (sel?.kind !== 'text' || !isCollapsed(sel)) return null;
  return sel.anchor;
}

/**
 * Block types where Enter continues the same type instead of a paragraph.
 *
 * @remarks
 * `toggle` used to be here and is not: a second toggle is never what you want
 * after naming the first one. What you want is its *contents*, so Enter nests
 * — see {@link splitBlock}.
 */
const CONTINUING_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

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

  /*
   * Enter at the very start makes room above, and changes nothing else. The
   * block keeps its type, its text and the caret; what appears above it is an
   * empty *paragraph* — a blank line, which is what anyone pressing Enter
   * there is asking for.
   *
   * Splitting at 0 gave the same shape only for a paragraph. For a heading it
   * handed the title to a new paragraph and left the empty heading above it,
   * so the title silently stopped being a title; for a list it left a stray
   * empty bullet rather than a blank line.
   */
  if (caret.offset === 0 && len > 0) {
    const spacer: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      text: [],
      children: [],
      parentId: block.parentId,
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: spacer, index: childIndex(editor.doc, block.id) }), {
      origin: 'input',
      selection: textCaret(block.id, 0),
    });
    return true;
  }

  const tail = sliceRuns(block.text ?? [], caret.offset, len);

  /*
   * A toggle's Enter goes *inside* it. After typing the summary, the next
   * thing anyone types is the content it hides — a second toggle is never it,
   * and that is what a sibling gave you. So the new block is a paragraph, it
   * is the toggle's first child, and the toggle opens to show it: typing into
   * something collapsed would be worse than the bug.
   *
   * Shift+Tab is the way back out, which `outdent` already does for any nested
   * block, the same as a list.
   */
  if (block.type === 'toggle') {
    const child: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      text: tail,
      children: [],
      parentId: block.id,
    };
    editor.dispatch(
      (tx) => {
        if (caret.offset < len) tx.op({ type: 'delete_text', id: block.id, from: caret.offset, to: len });
        if (block.props['collapsed'] === true) {
          tx.op({ type: 'update_block', id: block.id, patch: { props: { collapsed: false } } });
        }
        tx.op({ type: 'insert_block', block: child, index: 0 });
      },
      { origin: 'input', selection: textCaret(child.id, 0) },
    );
    return true;
  }

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

/**
 * Delete-at-end semantics: pull the next visible block into this one. A void
 * next block (divider, image) gets block-selected instead of destroyed.
 */
export function mergeForward(editor: Editor): boolean {
  const caret = caretOf(editor.selection);
  if (!caret) return false;
  const block = getBlock(editor.doc, caret.blockId);
  if (!editor.schema.get(block.type).inline) return false;
  if (caret.offset !== textLength(block.text)) return false;

  const order = visibleBlocks(editor.doc);
  const idx = order.findIndex((b) => b.id === block.id);
  const next = idx >= 0 ? order[idx + 1] : undefined;
  if (!next) return false;

  if (!editor.schema.get(next.type).inline) {
    editor.setSelection({ kind: 'block', anchor: next.id, head: next.id }, 'keyboard');
    return true;
  }

  const runs = next.text ?? [];
  editor.dispatch(
    (tx) => {
      let after: BlockId | null = next.id;
      for (const childId of [...next.children]) {
        tx.op({ type: 'move_block', id: childId, parentId: next.parentId!, after });
        after = childId;
      }
      if (runs.length) tx.op({ type: 'insert_text', id: block.id, offset: caret.offset, runs });
      tx.op({ type: 'delete_block', id: next.id });
    },
    { origin: 'input', selection: textCaret(block.id, caret.offset) },
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
  const at = singleBlockRange(editor);
  if (!at) return false;
  const { from, to } = at;
  if (from === to) return false;
  const block = getBlock(editor.doc, at.id);
  const add = !hasMark(block.text ?? [], from, to, markType);
  editor.dispatch(
    (tx) => tx.op({ type: 'format_text', id: block.id, from, to, mark: { type: markType, attrs }, add }),
    // the snapped range, so the selection matches what was actually formatted
    { origin: 'format', selection: { kind: 'text', anchor: { blockId: at.id, offset: from }, head: { blockId: at.id, offset: to } } },
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

// --- cross-block text ranges (ARCHITECTURE §5.2, D3) ---

export interface ResolvedRange {
  /** Blocks touched, in document order. */
  blocks: BlockId[];
  startBlockId: BlockId;
  startOffset: number;
  endBlockId: BlockId;
  endOffset: number;
  /** True when the range lives inside a single block. */
  single: boolean;
}

/**
 * Put a text selection into document order and enumerate the inline blocks it
 * covers. Everything that acts on a range (delete, format, copy) works from
 * this, so cross-block behaviour is defined in exactly one place.
 */
export function resolveTextRange(editor: Editor, sel: Selection = editor.selection): ResolvedRange | null {
  if (sel?.kind !== 'text') return null;
  const doc = editor.doc;
  if (!doc.blocks.has(sel.anchor.blockId) || !doc.blocks.has(sel.head.blockId)) return null;
  if (sel.anchor.blockId === sel.head.blockId) {
    const text = plainText(getBlock(doc, sel.anchor.blockId).text);
    /*
     * Snapping outward, never inward: an endpoint that landed mid-cluster — a
     * paste, a caret bookmark restored after the text moved, a range the
     * browser reported — would otherwise have half a character deleted or
     * formatted, and no later edit puts the halves back. Growing the range
     * keeps every character the user meant; shrinking it would silently drop
     * one.
     */
    const from = snapGrapheme(text, Math.min(sel.anchor.offset, sel.head.offset), 'back');
    const to = snapGrapheme(text, Math.max(sel.anchor.offset, sel.head.offset), 'forward');
    return {
      blocks: [sel.anchor.blockId],
      startBlockId: sel.anchor.blockId,
      startOffset: from,
      endBlockId: sel.anchor.blockId,
      endOffset: to,
      single: true,
    };
  }
  const order = visibleBlocks(doc)
    .filter((b) => editor.schema.get(b.type).inline)
    .map((b) => b.id);
  const ai = order.indexOf(sel.anchor.blockId);
  const hi = order.indexOf(sel.head.blockId);
  if (ai < 0 || hi < 0) return null;
  const forward = ai <= hi;
  const [startIdx, endIdx] = forward ? [ai, hi] : [hi, ai];
  const [start, end] = forward ? [sel.anchor, sel.head] : [sel.head, sel.anchor];
  return {
    blocks: order.slice(startIdx, endIdx + 1),
    startBlockId: start.blockId,
    startOffset: start.offset,
    endBlockId: end.blockId,
    endOffset: end.offset,
    single: false,
  };
}

/**
 * The selected range when it lies in a single block, in document order and
 * snapped off any character it would bisect.
 *
 * @remarks
 * Exists because this arithmetic was written out five separate times —
 * `toggleMark`, `insertText`, `deleteBackward`, the clipboard's inline paste
 * and the keymap's select-all — and they drifted the moment `resolveTextRange`
 * learned to snap. Formatting a range starting mid-emoji covered the whole
 * emoji while typing over the same range left half a surrogate behind.
 */
export function singleBlockRange(
  editor: Editor,
  sel: Selection = editor.selection,
): { id: BlockId; from: number; to: number } | null {
  const range = resolveTextRange(editor, sel);
  if (!range || !range.single) return null;
  return { id: range.startBlockId, from: range.startOffset, to: range.endOffset };
}

/** The covered [from, to) inside one block of a resolved range. */
export function rangeInBlock(editor: Editor, range: ResolvedRange, id: BlockId): { from: number; to: number } {
  const len = textLength(getBlock(editor.doc, id).text);
  if (range.single) return { from: range.startOffset, to: range.endOffset };
  if (id === range.startBlockId) return { from: range.startOffset, to: len };
  if (id === range.endBlockId) return { from: 0, to: range.endOffset };
  return { from: 0, to: len };
}

/**
 * Delete a text selection, including one spanning several blocks: the tail of
 * the first block and the head of the last are removed, blocks fully inside
 * disappear, and the remainder of the last block merges into the first —
 * exactly what a user expects from pressing Backspace over a selection.
 */
export function deleteTextSelection(editor: Editor): boolean {
  const range = resolveTextRange(editor);
  if (!range) return false;
  if (range.single) {
    if (range.startOffset === range.endOffset) return false;
    editor.dispatch(
      (tx) =>
        tx.op({ type: 'delete_text', id: range.startBlockId, from: range.startOffset, to: range.endOffset }),
      { origin: 'input', selection: textCaret(range.startBlockId, range.startOffset) },
    );
    return true;
  }

  const doc = editor.doc;
  const startLen = textLength(getBlock(doc, range.startBlockId).text);
  const endBlock = getBlock(doc, range.endBlockId);
  const tail = sliceRuns(endBlock.text ?? [], range.endOffset, textLength(endBlock.text));
  const middle = range.blocks.slice(1, -1);

  editor.dispatch(
    (tx) => {
      if (range.startOffset < startLen) {
        tx.op({ type: 'delete_text', id: range.startBlockId, from: range.startOffset, to: startLen });
      }
      // middle blocks vanish entirely, deepest first so delete_block sees leaves
      for (const id of [...middle].reverse()) {
        if (doc.blocks.has(id)) deleteSubtree(tx, doc, id);
      }
      if (!doc.blocks.has(range.endBlockId)) return; // was nested inside a deleted middle block
      if (tail.length) {
        tx.op({ type: 'insert_text', id: range.startBlockId, offset: range.startOffset, runs: tail });
      }
      // the last block's children are promoted where it stood, then it goes
      let after: BlockId | null = range.endBlockId;
      for (const childId of [...getBlock(doc, range.endBlockId).children]) {
        if (!doc.blocks.has(childId)) continue;
        tx.op({ type: 'move_block', id: childId, parentId: endBlock.parentId!, after });
        after = childId;
      }
      tx.op({ type: 'delete_block', id: range.endBlockId });
    },
    { origin: 'input', selection: textCaret(range.startBlockId, range.startOffset) },
  );
  return true;
}

/** Toggle a mark over a range, across blocks when the selection spans them. */
export function toggleMarkRange(editor: Editor, markType: string, attrs?: Record<string, unknown>): boolean {
  const range = resolveTextRange(editor);
  if (!range) return false;
  const parts = range.blocks
    .map((id) => ({ id, ...rangeInBlock(editor, range, id) }))
    // a `literal` block holds characters, not markup: there is no such thing as
    // bold inside a code block, and writing the mark anyway meant the Markdown
    // projection had to drop it on the next save. ⌘B still reached here.
    .filter((p) => p.to > p.from && !editor.schema.get(getBlock(editor.doc, p.id).type).literal);
  if (!parts.length) return false;

  // "already formatted" means every covered stretch carries the mark
  const add = !parts.every((p) => hasMark(getBlock(editor.doc, p.id).text ?? [], p.from, p.to, markType));
  const selection = editor.selection;
  editor.dispatch(
    (tx) => {
      for (const p of parts) {
        tx.op({ type: 'format_text', id: p.id, from: p.from, to: p.to, mark: { type: markType, attrs }, add });
      }
    },
    { origin: 'format', selection },
  );
  return true;
}

/** True when every covered stretch of the range carries the mark. */
export function rangeHasMark(editor: Editor, markType: string): boolean {
  const range = resolveTextRange(editor);
  if (!range) return false;
  const parts = range.blocks
    .map((id) => ({ id, ...rangeInBlock(editor, range, id) }))
    .filter((p) => p.to > p.from);
  return parts.length > 0 && parts.every((p) => hasMark(getBlock(editor.doc, p.id).text ?? [], p.from, p.to, markType));
}

// --- block selection commands (ARCHITECTURE §5.2) ---

/**
 * Resolve a block selection to its top-level selected blocks: the blocks in
 * the visible range whose ancestors are not themselves selected (a selected
 * block always implies its whole subtree).
 */
export function selectedBlocks(doc: Doc, sel: BlockSelection): BlockId[] {
  const order = visibleBlocks(doc).map((b) => b.id);
  const ai = order.indexOf(sel.anchor);
  const hi = order.indexOf(sel.head);
  if (ai < 0 || hi < 0) return [];
  const [from, to] = ai <= hi ? [ai, hi] : [hi, ai];
  const range = new Set(order.slice(from, to + 1));
  return order.slice(from, to + 1).filter((id) => !ancestors(doc, id).some((p) => range.has(p)));
}

function deleteSubtree(tx: Tx, doc: Doc, id: BlockId): void {
  for (const child of [...getBlock(doc, id).children]) {
    if (doc.blocks.has(child)) deleteSubtree(tx, doc, child);
  }
  tx.op({ type: 'delete_block', id });
}

export function deleteBlocks(editor: Editor, ids: BlockId[]): void {
  if (!ids.length) return;
  const isInline = (b: Block) => editor.schema.get(b.type).inline;
  const doomed = new Set(ids);
  const fallback = visibleBlocks(editor.doc).filter(
    (b) => isInline(b) && !doomed.has(b.id) && ![...doomed].some((d) => isDescendant(editor.doc, b.id, d)),
  );
  const first = ids[0]!;
  const order = visibleBlocks(editor.doc).map((b) => b.id);
  const beforeIdx = order.indexOf(first);
  const prev = [...fallback].reverse().find((b) => order.indexOf(b.id) < beforeIdx);
  const next = fallback.find((b) => order.indexOf(b.id) > beforeIdx);
  const target = prev ?? next ?? null;

  editor.dispatch(
    (tx) => {
      for (const id of ids) deleteSubtree(tx, editor.doc, id);
    },
    {
      origin: 'input',
      selection: target ? textCaret(target.id, prev ? textLength(target.text) : 0) : null,
    },
  );
}

function isDescendant(doc: Doc, id: BlockId, ancestor: BlockId): boolean {
  return ancestors(doc, id).includes(ancestor);
}

function cloneSubtree(doc: Doc, id: BlockId): { root: Block; all: Block[] } {
  const src = getBlock(doc, id);
  const copy: Block = { ...structuredClone(src), id: uuidv7() };
  const all: Block[] = [copy];
  copy.children = src.children.map((childId) => {
    const sub = cloneSubtree(doc, childId);
    sub.root.parentId = copy.id;
    all.push(...sub.all);
    return sub.root.id;
  });
  return { root: copy, all };
}

/**
 * Tick or untick every to-do among `ids`.
 *
 * @remarks
 * One transaction, so a list ticked from a block selection is one undo. A
 * mixed selection all becomes ticked — the same rule a "select all" checkbox
 * follows, and the one that makes a second press mean "and now clear them".
 * Ids that are not to-dos are skipped rather than rejected, so a caller can
 * pass a whole selection.
 *
 * @returns Whether anything was ticked.
 */
export function toggleChecked(editor: Editor, ids: BlockId[]): boolean {
  const todos = ids.filter((id) => editor.doc.blocks.get(id)?.type === 'to_do');
  if (!todos.length) return false;
  const checked = !todos.every((id) => getBlock(editor.doc, id).props['checked'] === true);
  editor.dispatch(
    (tx) => {
      for (const id of todos) tx.op({ type: 'update_block', id, patch: { props: { checked } } });
    },
    { origin: 'ui' },
  );
  return true;
}

/**
 * Put an empty paragraph right after a block, and the caret in it.
 *
 * @returns The new paragraph's id.
 *
 * @remarks
 * The way out of anything with no text in it. A void block — an image, a file,
 * an embed, a divider — has no caret to press Enter *in*, so the block
 * selection is where the key lands, and until this it landed nowhere: Enter on
 * a selected picture did nothing at all, and a page whose last block was a
 * picture had no way to keep writing except the mouse.
 *
 * The same three lines were written out in four places (the gutter's +, the
 * divider autoformat, Enter at offset 0). One of them is a command.
 */
export function insertParagraphAfter(editor: Editor, id: BlockId): BlockId {
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
  editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph, index: childIndex(editor.doc, id) + 1 }), {
    origin: 'input',
    selection: textCaret(paragraph.id, 0),
  });
  return paragraph.id;
}

export function duplicateBlocks(editor: Editor, ids: BlockId[]): BlockId[] {
  if (!ids.length) return [];
  const last = ids[ids.length - 1]!;
  const newIds: BlockId[] = [];
  editor.dispatch(
    (tx) => {
      let after = last;
      for (const id of ids) {
        const { root, all } = cloneSubtree(editor.doc, id);
        root.parentId = getBlock(editor.doc, last).parentId;
        newIds.push(root.id);
        // parent-first: descendants are already listed in their parent's clone,
        // so insert_block only registers them (no re-splice)
        tx.op({ type: 'insert_block', block: root, index: childIndex(editor.doc, after) + 1 });
        for (const b of all.slice(1)) tx.op({ type: 'insert_block', block: b, index: 0 });
        after = root.id;
      }
    },
    { origin: 'input', selection: editor.selection },
  );
  return newIds;
}

/** Move a contiguous group of sibling blocks one slot up or down. */
export function moveBlocksVertical(editor: Editor, ids: BlockId[], dir: 'up' | 'down'): boolean {
  if (!ids.length) return false;
  const first = getBlock(editor.doc, ids[0]!);
  const parent = getBlock(editor.doc, first.parentId!);
  if (!ids.every((id) => getBlock(editor.doc, id).parentId === parent.id)) return false;
  const idxs = ids.map((id) => parent.children.indexOf(id)).sort((a, b) => a - b);
  const lo = idxs[0]!;
  const hi = idxs[idxs.length - 1]!;
  if (dir === 'up' && lo === 0) return false;
  if (dir === 'down' && hi === parent.children.length - 1) return false;
  const ordered = parent.children.slice(lo, hi + 1);
  editor.dispatch(
    (tx) => {
      let after: BlockId | null =
        dir === 'up' ? (lo >= 2 ? parent.children[lo - 2]! : null) : parent.children[hi + 1]!;
      for (const id of ordered) {
        tx.op({ type: 'move_block', id, parentId: parent.id, after });
        after = id;
      }
    },
    { origin: 'input', selection: editor.selection },
  );
  return true;
}

/** Move blocks to an explicit position (drag & drop before/after). */
export function moveBlocks(editor: Editor, ids: BlockId[], parentId: BlockId, after: BlockId | null): void {
  editor.dispatch(
    (tx) => {
      let anchor = after;
      for (const id of ids) {
        tx.op({ type: 'move_block', id, parentId, after: anchor });
        anchor = id;
      }
    },
    /*
     * No `selection`. Passing back the one it already had made the transaction
     * claim it had *chosen* a caret, and a chosen caret is one the view scrolls
     * to. Dropping a dragged block at the top of a long page, with a caret left
     * in the last one, threw the page down to that caret — the caret was never
     * what moved. `moveBlocksVertical` does pass one, and should: there the
     * caret is inside the block being moved.
     */
    { origin: 'input' },
  );
}

/** An empty column holding one empty paragraph. */
function emptyColumn(parentId: BlockId): { column: Block; paragraph: Block } {
  const column: Block = { id: uuidv7(), type: 'column', version: 1, props: {}, children: [], parentId };
  const paragraph: Block = {
    id: uuidv7(),
    type: 'paragraph',
    version: 1,
    props: {},
    text: [],
    children: [],
    parentId: column.id,
  };
  return { column, paragraph };
}

/**
 * A column layout, asked for rather than dragged into being.
 *
 * @remarks
 * The side-drop gesture that builds columns is experimental and off by
 * default, so until now a column layout was unreachable in the shipping
 * configuration — `EditorViewOptions.columns` says columns "stay reachable
 * from the slash menu either way", and they were not.
 *
 * Every column starts with an empty paragraph, and that is not a nicety:
 * `normalizeWrappers` deletes a column whose children are all gone, and
 * `[].every(…)` is `true` — so a layout built out of genuinely empty columns
 * dissolves in the same transaction that creates it.
 *
 * @returns The id to put the caret in, or `null` at the document root.
 */
export function insertColumns(editor: Editor, afterBlockId: BlockId, count = 2): BlockId | null {
  const doc = editor.doc;
  const parentId = getBlock(doc, afterBlockId).parentId;
  if (!parentId) return null;
  const list: Block = { id: uuidv7(), type: 'column_list', version: 1, props: {}, children: [], parentId };
  const columns = Array.from({ length: Math.max(2, count) }, () => emptyColumn(list.id));
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'insert_block', block: list, index: childIndex(doc, afterBlockId) + 1 });
      columns.forEach(({ column, paragraph }, i) => {
        tx.op({ type: 'insert_block', block: column, index: i });
        tx.op({ type: 'insert_block', block: paragraph, index: 0 });
      });
    },
    { origin: 'input' },
  );
  return columns[0]!.paragraph.id;
}

/**
 * Add or remove columns, keeping what was written in them.
 *
 * @remarks
 * Removing is the half worth being careful about: the blocks in a column that
 * goes away move into the last surviving one rather than being deleted, so
 * asking for fewer columns is a layout change and never a loss of text.
 */
export function setColumnCount(editor: Editor, listId: BlockId, count: number): void {
  const doc = editor.doc;
  const list = getBlock(doc, listId);
  if (list.type !== 'column_list') return;
  const wanted = Math.max(2, count);
  const current = list.children.length;
  if (wanted === current) return;

  editor.dispatch(
    (tx) => {
      if (wanted > current) {
        for (let i = current; i < wanted; i++) {
          const { column, paragraph } = emptyColumn(list.id);
          tx.op({ type: 'insert_block', block: column, index: i });
          tx.op({ type: 'insert_block', block: paragraph, index: 0 });
        }
        return;
      }
      const keep = getBlock(doc, list.children[wanted - 1]!);
      let after: BlockId | null = keep.children[keep.children.length - 1] ?? null;
      for (const columnId of list.children.slice(wanted)) {
        for (const childId of [...getBlock(doc, columnId).children]) {
          tx.op({ type: 'move_block', id: childId, parentId: keep.id, after });
          after = childId;
        }
        tx.op({ type: 'delete_block', id: columnId });
      }
    },
    { origin: 'ui' },
  );
}

/**
 * How the width is shared out: one `ratio` per column, as `flex-grow`.
 *
 * @remarks
 * Ratios rather than widths, because the container's width is the host's and
 * a column that states pixels stops being responsive. Extra entries are
 * ignored and missing ones leave the column at its default 1.
 */
export function setColumnRatios(editor: Editor, listId: BlockId, ratios: readonly number[]): void {
  const doc = editor.doc;
  const list = getBlock(doc, listId);
  if (list.type !== 'column_list') return;
  editor.dispatch(
    (tx) => {
      list.children.forEach((id, i) => {
        tx.op({ type: 'update_block', id, patch: { props: { ratio: ratios[i] ?? 1 } } });
      });
    },
    { origin: 'ui' },
  );
}

/**
 * Drop blocks on the left/right edge of a target (ARCHITECTURE §7): wraps the
 * target in a column_list, or adds a column when the target is already one.
 */
export function moveIntoColumns(
  editor: Editor,
  ids: BlockId[],
  targetId: BlockId,
  side: 'left' | 'right',
): void {
  const doc = editor.doc;
  const target = getBlock(doc, targetId);
  const targetParent = getBlock(doc, target.parentId!);

  editor.dispatch(
    (tx) => {
      const newColumn = (parentId: BlockId): Block => ({
        id: uuidv7(),
        type: 'column',
        version: 1,
        props: {},
        children: [],
        parentId,
      });

      if (targetParent.type === 'column') {
        // add a sibling column to the existing column_list
        const list = getBlock(doc, targetParent.parentId!);
        const col = newColumn(list.id);
        const colIdx = list.children.indexOf(targetParent.id);
        tx.op({ type: 'insert_block', block: col, index: side === 'left' ? colIdx : colIdx + 1 });
        let after: BlockId | null = null;
        for (const id of ids) {
          tx.op({ type: 'move_block', id, parentId: col.id, after });
          after = id;
        }
        return;
      }

      const list: Block = {
        id: uuidv7(),
        type: 'column_list',
        version: 1,
        props: {},
        children: [],
        parentId: target.parentId,
      };
      tx.op({ type: 'insert_block', block: list, index: childIndex(doc, targetId) });
      const colA = newColumn(list.id);
      const colB = newColumn(list.id);
      tx.op({ type: 'insert_block', block: colA, index: 0 });
      tx.op({ type: 'insert_block', block: colB, index: 1 });
      const targetCol = side === 'left' ? colB : colA;
      const draggedCol = side === 'left' ? colA : colB;
      tx.op({ type: 'move_block', id: targetId, parentId: targetCol.id, after: null });
      let after: BlockId | null = null;
      for (const id of ids) {
        tx.op({ type: 'move_block', id, parentId: draggedCol.id, after });
        after = id;
      }
    },
    { origin: 'input', selection: editor.selection },
  );
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
  // both spellings of a checklist: Notion's `[]` and Markdown's `[ ]`, either
  // case for the tick. `- ` before them has already made the block a bullet,
  // which `handleInsertText` allows a to-do rule — and only a to-do rule — to
  // convert.
  { prefix: '[] ', type: 'to_do' },
  { prefix: '[ ] ', type: 'to_do' },
  { prefix: '[x] ', type: 'to_do', props: { checked: true } },
  { prefix: '[X] ', type: 'to_do', props: { checked: true } },
  { prefix: '> ', type: 'toggle' }, // Notion: '>' is toggle, '"' is quote
  { prefix: '" ', type: 'quote' },
];

/**
 * The rule for what was typed, or null.
 *
 * @param textBeforeCaret - Everything before the caret in the block.
 * @param plugins - Registered block plugins, whose own shortcuts are tried
 * first so a plugin can claim a prefix (` ``` ` belongs to `@nbe/blocks-code`,
 * not to this list).
 */
export function matchAutoformat(textBeforeCaret: string, plugins?: PluginRegistry): AutoformatRule | null {
  for (const plugin of plugins?.all() ?? []) {
    const rule = plugin.autoformat?.find((r) => r.prefix === textBeforeCaret);
    if (rule) return rule;
  }
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

// --- inline markdown autoformat: **bold**, *italic*, `code`, ~~strike~~, [text](url) ---

export interface InlineFormatMatch {
  /** Offset where the markdown span starts. */
  from: number;
  /** Offset just past the closing delimiter (the caret). */
  to: number;
  /** Length of the opening delimiter to strip. */
  prefix: number;
  /** Length of the closing delimiter to strip. */
  suffix: number;
  mark: { type: string; attrs?: Record<string, unknown> };
}

/*
 * Content must not start or end with whitespace (CommonMark), which keeps
 * `a * b * c` prose from italicizing. A lone `*` opener must not sit against
 * another `*`, so typing the first closing star of `**bold**` cannot fire the
 * italic rule on `*bold`; `_` additionally refuses to open mid-word, so
 * snake_case_names survive. Delimiter characters are excluded from content, so
 * the leftmost match cannot swallow an earlier closed span.
 */
const INLINE_RULES: { re: RegExp; type: string }[] = [
  { re: /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/, type: 'bold' },
  { re: /__([^\s_](?:[^_]*[^\s_])?)__$/, type: 'bold' },
  { re: /(?<!\*)\*([^\s*](?:[^*]*[^\s*])?)\*$/, type: 'italic' },
  { re: /(?<![\w_])_([^\s_](?:[^_]*[^\s_])?)_$/, type: 'italic' },
  { re: /~~([^\s~](?:[^~]*[^\s~])?)~~$/, type: 'strike' },
  { re: /`([^`]+)`$/, type: 'code' },
];

const LINK_RULE = /\[([^[\]]+)\]\((\S+)\)$/;

/** Inline markdown span ending exactly at the caret, or null. */
export function matchInlineFormat(textBeforeCaret: string): InlineFormatMatch | null {
  for (const { re, type } of INLINE_RULES) {
    const m = re.exec(textBeforeCaret);
    if (!m) continue;
    const delim = (m[0].length - m[1]!.length) / 2;
    return { from: m.index, to: textBeforeCaret.length, prefix: delim, suffix: delim, mark: { type } };
  }
  const link = LINK_RULE.exec(textBeforeCaret);
  if (link) {
    return {
      from: link.index,
      to: textBeforeCaret.length,
      prefix: 1,
      suffix: link[0].length - 1 - link[1]!.length,
      mark: { type: 'link', attrs: { href: link[2]! } },
    };
  }
  return null;
}

/**
 * Strip the delimiters and mark what they enclosed. Deleting only the
 * delimiters (rather than replacing the span) keeps marks already inside the
 * content, so `**a *b* c**` ends bold with the italic intact.
 */
export function applyInlineFormat(editor: Editor, id: BlockId, m: InlineFormatMatch): void {
  const end = m.to - m.prefix - m.suffix;
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'delete_text', id, from: m.to - m.suffix, to: m.to });
      tx.op({ type: 'delete_text', id, from: m.from, to: m.from + m.prefix });
      tx.op({ type: 'format_text', id, from: m.from, to: end, mark: m.mark, add: true });
    },
    { origin: 'input', selection: textCaret(id, end) },
  );
}

/** Insert a plain-text run at the caret, replacing any selected range first. */
export function insertText(editor: Editor, data: string, marks?: Run['marks']): boolean {
  const at = singleBlockRange(editor);
  if (!at) return false;
  const { id, from, to } = at;
  editor.dispatch(
    (tx) => {
      if (from < to) tx.op({ type: 'delete_text', id, from, to });
      tx.op({ type: 'insert_text', id, offset: from, runs: [{ text: data, marks }] });
    },
    { origin: 'input', selection: textCaret(id, from + data.length), coalesce: `typing:${id}` },
  );
  return true;
}

/** Delete the selected range, or one perceived character backward. */
export function deleteBackward(editor: Editor): boolean {
  const at = singleBlockRange(editor);
  if (!at) return false;
  const { id, from, to } = at;
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
  // one press, one perceived character: a family emoji is eight code units and
  // used to come apart into visible debris on the way out (AQ#4)
  const start = prevGrapheme(plain, from);
  editor.dispatch((tx) => tx.op({ type: 'delete_text', id, from: start, to: from }), {
    origin: 'input',
    selection: textCaret(id, start),
    coalesce: `typing:${id}`,
  });
  return true;
}
