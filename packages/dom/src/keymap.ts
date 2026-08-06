import {
  deleteBlocks,
  duplicateBlocks,
  getBlock,
  indent,
  insertText,
  isCollapsed,
  mergeBackward,
  moveBlocksVertical,
  nextInlineBlock,
  outdent,
  previousInlineBlock,
  selectedBlocks,
  splitBlock,
  textCaret,
  textLength,
  toggleMark,
  visibleBlocks,
  type BlockSelection,
} from '@nbe/core';
import type { EditorView } from './view';
import { domToModelPoint, leafOf } from './selection';

/** Current collapsed-caret X in client coordinates (goal-X seed). */
function caretClientX(view: EditorView): number | null {
  const s = document.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const rect = s.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0) {
    return leafOf(s.getRangeAt(0).startContainer)?.getBoundingClientRect().left ?? null;
  }
  return rect.left;
}

/** Model offset closest to `x` on the first or last visual line of a block. */
function offsetAtX(view: EditorView, blockId: string, x: number, edge: 'first' | 'last'): number {
  const block = getBlock(view.editor.doc, blockId);
  const fallback = edge === 'first' ? 0 : textLength(block.text);
  const leaf = view.leafEl(blockId);
  if (!leaf) return fallback;
  const rect = leaf.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(leaf).lineHeight) || 24;
  const y =
    edge === 'first'
      ? Math.min(rect.top + line / 2, rect.bottom - 2)
      : Math.max(rect.bottom - line / 2, rect.top + 2);
  const cx = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(cx, y);
  if (pos) {
    const p = domToModelPoint(pos.offsetNode, pos.offset);
    if (p?.blockId === blockId) return p.offset;
  }
  const range = doc.caretRangeFromPoint?.(cx, y);
  if (range) {
    const p = domToModelPoint(range.startContainer, range.startOffset);
    if (p?.blockId === blockId) return p.offset;
  }
  return fallback;
}

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
        e.preventDefault();
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
        const from = Math.min(sel.anchor.offset, sel.head.offset);
        const to = Math.max(sel.anchor.offset, sel.head.offset);
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
        toggleMark(editor, { b: 'bold', i: 'italic', u: 'underline', e: 'code' }[key]!);
        return;
      }
      if (e.shiftKey && key === 's') {
        e.preventDefault();
        toggleMark(editor, 'strike');
        return;
      }
      return;
    }

    switch (e.key) {
      case 'Escape': {
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
