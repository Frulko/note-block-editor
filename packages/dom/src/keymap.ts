import {
  getBlock,
  indent,
  insertText,
  isCollapsed,
  mergeBackward,
  nextInlineBlock,
  outdent,
  plainText,
  previousInlineBlock,
  splitBlock,
  textLength,
  toggleMark,
} from '@nbe/core';
import type { EditorView } from './view';
import { leafOf } from './selection';

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

  const onKeyDown = (e: KeyboardEvent) => {
    if (view.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    const sel = editor.selection;
    const caret = sel?.kind === 'text' && isCollapsed(sel) ? sel.anchor : null;
    const isInline = (b: { type: string }) => editor.schema.get(b.type).inline;

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
            // ponytail: caret goes to end of previous block; goal-X preservation later
            view.focusBlock(prev.id, textLength(prev.text));
          }
        }
        return;
      }
      case 'ArrowDown': {
        if (caret && !e.shiftKey && caretLine(view)?.last) {
          const next = nextInlineBlock(editor.doc, caret.blockId, isInline);
          if (next) {
            e.preventDefault();
            view.focusBlock(next.id, 0);
          }
        }
        return;
      }
    }
  };

  view.content.addEventListener('keydown', onKeyDown);
  return () => view.content.removeEventListener('keydown', onKeyDown);
}
