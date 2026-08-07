import {
  cellAt,
  cellPosition,
  deleteBlocks,
  duplicateBlocks,
  getBlock,
  indent,
  insertRow,
  insertText,
  isCollapsed,
  mergeBackward,
  moveBlocksVertical,
  nextInlineBlock,
  outdent,
  previousInlineBlock,
  selectedBlocks,
  singleBlockRange,
  splitBlock,
  tableCells,
  tableRows,
  textCaret,
  textLength,
  toggleMarkRange,
  type BlockSelection,
  visibleBlocks,
} from '@nbe/core';
import type { EditorView } from './view';
import { leafOf } from './selection';
import { caretClientX, offsetAtX, syncCaretFromDom } from './caret';

function caretLine(view: EditorView): { first: boolean; last: boolean } | null {
  const s = document.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const range = s.getRangeAt(0);
  const leaf = leafOf(range.startContainer);
  if (!leaf) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0) return { first: true, last: true }; // empty leaf
  const leafRect = leaf.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(leaf).lineHeight) || 24;
  return {
    first: rect.top - leafRect.top < line * 0.75,
    last: leafRect.bottom - rect.bottom < line * 0.75,
  };
}

/**
 * Tab through table cells. Tabbing past the last cell appends a row, so a
 * table can be filled entirely from the keyboard.
 */
function moveThroughCells(view: EditorView, blockId: string, direction: 1 | -1): boolean {
  const editor = view.editor;
  const position = cellPosition(editor.doc, blockId);
  if (!position) return false;
  const cells = tableCells(editor.doc, position.tableId);
  const index = cells.findIndex((c) => c.id === blockId);
  const next = cells[index + direction];
  if (next) {
    view.focusBlock(next.id, textLength(next.text));
    return true;
  }
  if (direction === -1) return true; // at the first cell: stay put, never indent
  const rows = tableRows(editor.doc, position.tableId).length;
  insertRow(editor, position.tableId, rows);
  view.syncDomSelection();
  return true;
}

/** Enter in a cell: down one row, creating it when at the bottom. */
function moveDownCell(view: EditorView, blockId: string): void {
  const editor = view.editor;
  const position = cellPosition(editor.doc, blockId);
  if (!position) return;
  const below = cellAt(editor.doc, position.tableId, position.row + 1, position.column);
  if (below) {
    view.focusBlock(below.id, textLength(below.text));
    return;
  }
  insertRow(editor, position.tableId, position.row + 1);
  const created = cellAt(editor.doc, position.tableId, position.row + 1, position.column);
  if (created) view.focusBlock(created.id, 0);
}

/**
 * Escape is a chain, evaluated in this order, and each link consumes the key
 * so the next never sees it:
 *
 *   1. the top overlay          (ui/overlay.ts, capture phase)
 *   2. an active pointer gesture (gestures.ts, capture phase)
 *   3. a block selection → cleared          ┐ here, in the bubble phase, on
 *   4. a text selection  → block selection  ┘ the editor content
 *
 * The first two run in capture precisely so an open menu beats the editor:
 * without that, Escape behind a menu would drop out of text mode instead of
 * closing what the user was looking at.
 */
export function attachKeymap(view: EditorView): () => void {
  const editor = view.editor;
  const isInline = (b: { type: string }) => editor.schema.get(b.type).inline;
  /** Sticky horizontal target across consecutive vertical arrow moves (goal-X). */
  let goalX: number | null = null;

  const handleBlockMode = (e: KeyboardEvent, sel: BlockSelection): void => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const order = visibleBlocks(editor.doc).map((b) => b.id);
    const headIdx = order.indexOf(sel.head);

    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault();
      if (order.length) {
        editor.setSelection({ kind: 'block', anchor: order[0]!, head: order[order.length - 1]! }, 'keyboard');
      }
      return;
    }
    if (mod && key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateBlocks(editor, selectedBlocks(editor.doc, sel));
      return;
    }
    if (mod && e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      moveBlocksVertical(editor, selectedBlocks(editor.doc, sel), key === 'ArrowUp' ? 'up' : 'down');
      view.editor.setSelection(sel, 'keyboard'); // re-render overlays at the new position
      return;
    }
    switch (key) {
      case 'Enter': {
        e.preventDefault();
        const head = getBlock(editor.doc, sel.head);
        if (isInline(head)) view.focusBlock(head.id, textLength(head.text));
        return;
      }
      case 'Escape':
        // last link of the Escape chain: overlays and gestures already had
        // their turn in the capture phase, so reaching here with a block
        // selection means the user wants out of it
        e.preventDefault();
        editor.setSelection(null, 'keyboard');
        return;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        deleteBlocks(editor, selectedBlocks(editor.doc, sel));
        return;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const next = order[headIdx + (key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        editor.setSelection(
          { kind: 'block', anchor: e.shiftKey ? sel.anchor : next, head: next },
          'keyboard',
        );
        return;
      }
      case 'Tab': {
        e.preventDefault();
        const ids = selectedBlocks(editor.doc, sel);
        if (ids.length === 1) (e.shiftKey ? outdent : indent)(editor, ids[0]!);
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (view.composing) return;
    if ((e.target as HTMLElement).closest?.('input, textarea, [data-nbe-ui]')) return;
    // the DOM caret is the truth — never act on a stale model selection
    syncCaretFromDom(view);
    const mod = e.metaKey || e.ctrlKey;
    const sel = editor.selection;

    const vertical = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey;
    if (vertical) goalX ??= caretClientX(view);
    else goalX = null;

    // undo/redo work in every mode
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (key === 'y' && !e.shiftKey) {
        e.preventDefault();
        editor.redo();
        return;
      }
    }

    if (sel?.kind === 'block') {
      handleBlockMode(e, sel);
      return;
    }

    const caret = sel?.kind === 'text' && isCollapsed(sel) ? sel.anchor : null;

    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'a') {
        // Cmd+A escalation: block text → whole document (Notion)
        if (sel?.kind !== 'text') return;
        e.preventDefault();
        const block = getBlock(editor.doc, sel.anchor.blockId);
        const len = textLength(block.text);
        const at = singleBlockRange(editor);
        const from = at?.from ?? 0;
        const to = at?.to ?? len;
        if (from === 0 && to === len) {
          editor.setSelection({ kind: 'block', anchor: block.id, head: block.id }, 'keyboard');
        } else {
          editor.setSelection(
            { kind: 'text', anchor: { blockId: block.id, offset: 0 }, head: { blockId: block.id, offset: len } },
            'keyboard',
          );
          view.syncDomSelection();
        }
        return;
      }
      if (key === 'd' && !e.shiftKey && caret) {
        e.preventDefault();
        duplicateBlocks(editor, [caret.blockId]);
        return;
      }
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && caret) {
        e.preventDefault();
        moveBlocksVertical(editor, [caret.blockId], e.key === 'ArrowUp' ? 'up' : 'down');
        view.syncDomSelection();
        return;
      }
      if (!e.shiftKey && (key === 'b' || key === 'i' || key === 'u' || key === 'e')) {
        e.preventDefault();
        toggleMarkRange(editor, { b: 'bold', i: 'italic', u: 'underline', e: 'code' }[key]!);
        return;
      }
      if (e.shiftKey && key === 's') {
        e.preventDefault();
        toggleMarkRange(editor, 'strike');
        return;
      }
      return;
    }

    switch (e.key) {
      case 'Escape': {
        // text → block selection; a second press then clears it (above)
        if (caret) {
          e.preventDefault();
          editor.setSelection({ kind: 'block', anchor: caret.blockId, head: caret.blockId }, 'keyboard');
        }
        return;
      }
      case 'Enter': {
        if (e.shiftKey) {
          e.preventDefault();
          insertText(editor, '\n');
          return;
        }
        // a cell never splits: Enter moves to the cell below, adding a row at
        // the bottom edge, which is how a table is filled in by typing
        if (caret && getBlock(editor.doc, caret.blockId).type === 'table_cell') {
          e.preventDefault();
          moveDownCell(view, caret.blockId);
          return;
        }
        if (caret && getBlock(editor.doc, caret.blockId).type === 'code') {
          e.preventDefault();
          insertText(editor, '\n');
          return;
        }
        e.preventDefault();
        splitBlock(editor);
        return;
      }
      case 'Backspace': {
        if (caret && caret.offset === 0) {
          e.preventDefault();
          mergeBackward(editor);
        }
        return; // otherwise beforeinput deleteContentBackward handles it
      }
      case 'Tab': {
        e.preventDefault();
        if (!caret) return;
        // inside a table, Tab walks cells instead of indenting (Notion)
        if (moveThroughCells(view, caret.blockId, e.shiftKey ? -1 : 1)) return;
        if (e.shiftKey) outdent(editor, caret.blockId);
        else indent(editor, caret.blockId);
        view.syncDomSelection();
        return;
      }
      case 'ArrowLeft': {
        if (caret && caret.offset === 0 && !e.shiftKey) {
          const prev = previousInlineBlock(editor.doc, caret.blockId, isInline);
          if (prev) {
            e.preventDefault();
            view.focusBlock(prev.id, textLength(prev.text));
          }
        }
        return;
      }
      case 'ArrowRight': {
        if (caret && !e.shiftKey) {
          const len = textLength(getBlock(editor.doc, caret.blockId).text);
          if (caret.offset === len) {
            const next = nextInlineBlock(editor.doc, caret.blockId, isInline);
            if (next) {
              e.preventDefault();
              view.focusBlock(next.id, 0);
            }
          }
        }
        return;
      }
      case 'ArrowUp': {
        if (caret && !e.shiftKey && caretLine(view)?.first) {
          const prev = previousInlineBlock(editor.doc, caret.blockId, isInline);
          if (prev) {
            e.preventDefault();
            view.focusBlock(prev.id, goalX !== null ? offsetAtX(view, prev.id, goalX, 'last') : textLength(prev.text));
          }
        }
        return;
      }
      case 'ArrowDown': {
        if (caret && !e.shiftKey && caretLine(view)?.last) {
          const next = nextInlineBlock(editor.doc, caret.blockId, isInline);
          if (next) {
            e.preventDefault();
            view.focusBlock(next.id, goalX !== null ? offsetAtX(view, next.id, goalX, 'first') : 0);
          }
        }
        return;
      }
    }
  };

  view.content.addEventListener('keydown', onKeyDown);
  return () => view.content.removeEventListener('keydown', onKeyDown);
}
