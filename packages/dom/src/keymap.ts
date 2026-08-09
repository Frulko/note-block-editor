import {
  ancestors,
  byPrecedence,
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
  singleBlockRange,
  splitBlock,
  textCaret,
  textLength,
  toggleChecked,
  toggleMarkRange,
  type BlockSelection,
  visibleBlocks,
} from '@nbe/core';
import type { EditorView } from './view';
import { viewOf } from './block-view';
import { domToModelPoint, leafOf } from './selection';
import { caretClientX, offsetAtX, syncCaretFromDom } from './caret';

/**
 * macOS gives Control a text-editing keymap of its own — `^A`/`^E` to the ends
 * of the line, `^K` to kill to the end, `^F`/`^B`/`^N`/`^P` to move, `^D` to
 * delete forward — and every browser implements it inside a contenteditable.
 * Reading Control as the command modifier there stole all of them: `^A`
 * selected the block instead of moving the caret, `^E` toggled code.
 *
 * So Command is the modifier on a Mac, and Control is the modifier everywhere
 * else. Command is *also* accepted off a Mac, because a Linux or Windows host
 * that sends it means the command modifier and nothing else does.
 */
const IS_MAC = /Mac|iP(hone|ad|od)/.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
);

/** True when the event carries this platform's command modifier. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || (e.ctrlKey && !IS_MAC);
}

function caretLine(view: EditorView): { first: boolean; last: boolean } | null {
  const s = document.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const range = s.getRangeAt(0);
  const leaf = leafOf(range.startContainer);
  if (!leaf) return null;

  /*
   * Two answers, and both have to agree.
   *
   * A hard line break is a fact: a `\n` before the caret means it is not on
   * the first line whatever the geometry says. That is what the geometry got
   * wrong — a collapsed range sitting after a *trailing* newline reports no
   * rect at all in Chromium and a top-of-the-leaf rect in WebKit, so both read
   * as "first line" and ArrowUp left the block from the empty line Enter had
   * just made.
   *
   * The rect is a fact too, and the only one that can see *wrapping*: a long
   * line with no break in it is still several lines on screen. So neither
   * alone: a line is the first when there is no break above it and nothing
   * above it on screen.
   */
  const text = leaf.textContent ?? '';
  const at = domToModelPoint(range.startContainer, range.startOffset);
  const breakBefore = at ? text.slice(0, at.offset).includes('\n') : false;
  const breakAfter = at ? text.slice(at.offset).includes('\n') : false;

  const rect = range.getBoundingClientRect();
  // no rect: an empty leaf, or a caret past a trailing break — the breaks decide
  if (rect.width === 0 && rect.height === 0 && rect.top === 0) {
    return { first: !breakBefore, last: !breakAfter };
  }
  const leafRect = leaf.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(leaf).lineHeight) || 24;
  return {
    first: !breakBefore && rect.top - leafRect.top < line * 0.75,
    last: !breakAfter && leafRect.bottom - rect.bottom < line * 0.75,
  };
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
/**
 * Give the plugins owning the caret's block — and its ancestors — first
 * refusal on the key. Returns true when one handled it.
 */
function pluginKey(view: EditorView, event: KeyboardEvent, blockId: string): boolean {
  const doc = view.editor.doc;
  if (!doc.blocks.has(blockId)) return false;
  for (const id of [blockId, ...ancestors(doc, blockId)]) {
    const block = doc.blocks.get(id);
    const declared = block && viewOf(view.plugins.get(block.type))?.keys?.[event.key];
    if (!declared || !block) continue;
    for (const handler of byPrecedence([declared])) {
      if (handler({ view, block, event })) return true;
    }
  }
  return false;
}

export function attachKeymap(view: EditorView): () => void {
  const editor = view.editor;
  const isInline = (b: { type: string }) => editor.schema.get(b.type).inline;
  /** Sticky horizontal target across consecutive vertical arrow moves (goal-X). */
  let goalX: number | null = null;

  const handleBlockMode = (e: KeyboardEvent, sel: BlockSelection): void => {
    const mod = isMod(e);
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
    if ((mod && e.shiftKey) || (e.altKey && !mod)) {
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault();
        const ids = selectedBlocks(editor.doc, sel);
        if (e.altKey && e.shiftKey) duplicateBlocks(editor, ids);
        else {
          moveBlocksVertical(editor, ids, key === 'ArrowUp' ? 'up' : 'down');
          view.editor.setSelection(sel, 'keyboard'); // re-render overlays at the new position
        }
        return;
      }
    }
    if (mod && key === 'Enter' && toggleChecked(editor, selectedBlocks(editor.doc, sel))) {
      e.preventDefault();
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
    const mod = isMod(e);
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

    /*
     * A block plugin's own keys, before the built-ins. Consulted for the block
     * the caret is in *and* its ancestors, so a table can own Tab for a cell
     * without the cell having to know it is in a table — the same walk
     * `blockActionEntries` does, and the reason `keys` is per block type
     * rather than a global keymap contribution.
     */
    if (sel?.kind === 'text' && pluginKey(view, e, sel.head.blockId)) return;

    const caret = sel?.kind === 'text' && isCollapsed(sel) ? sel.anchor : null;

    /*
     * The line bindings from the editors this is used beside: `⌥↑`/`⌥↓` moves
     * the block, `⇧⌥↑`/`⇧⌥↓` copies it — VS Code's "move line" and "copy
     * line", PhpStorm's "move line". They alias Notion's `⌘⇧↑`/`⌘⇧↓` rather
     * than replacing it, so neither muscle memory is wrong.
     *
     * This one *is* worth taking from macOS, unlike `^A`/`^E`: `⌥↑`/`⌥↓` there
     * means "to the start/end of the paragraph", and a paragraph is a block —
     * so the caret lands where Home and End already put it. Both directions of
     * the copy leave the same document; only VS Code's caret differs, and
     * `duplicateBlocks` places it.
     */
    if (e.altKey && !mod && caret && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.shiftKey) duplicateBlocks(editor, [caret.blockId]);
      else moveBlocksVertical(editor, [caret.blockId], e.key === 'ArrowUp' ? 'up' : 'down');
      view.syncDomSelection();
      return;
    }

    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      /*
       * Tick the to-do without reaching for the mouse — Notion's binding, and
       * the one thing a checklist needs that a checkbox in the gutter cannot
       * give you while both hands are on the keyboard.
       */
      if (e.key === 'Enter' && caret && toggleChecked(editor, [caret.blockId])) {
        e.preventDefault();
        return;
      }
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
      /*
       * Delete the block, not the line. `Cmd+Backspace` is "delete to the
       * start of the line" on a Mac, which in a block editor is a shortcut for
       * something you can already do by holding Backspace. Removing the block
       * outright is the one it was asked for, and it is reachable without
       * first leaving text mode with Escape.
       *
       * Command only, never Control: off a Mac `Ctrl+Backspace`/`Ctrl+Delete`
       * is the *word* delete every text field on the platform has, so taking
       * it here broke the one binding Linux and Windows cannot reach any other
       * way. It falls through to `beforeinput` and `handleDeleteBy`; there,
       * deleting the block stays Escape then Backspace.
       */
      if (e.metaKey && (e.key === 'Backspace' || e.key === 'Delete') && sel?.kind === 'text') {
        e.preventDefault();
        deleteBlocks(
          editor,
          selectedBlocks(editor.doc, { kind: 'block', anchor: sel.anchor.blockId, head: sel.head.blockId }),
        );
        view.syncDomSelection();
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
      // ⌘. / ⌘, — the pair every word processor uses for the shifted marks
      if (!e.shiftKey && (e.key === '.' || e.key === ',')) {
        e.preventDefault();
        toggleMarkRange(editor, e.key === '.' ? 'superscript' : 'subscript');
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
