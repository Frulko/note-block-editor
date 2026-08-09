import type { Block, BlockId } from '@nbe/core';
import {
  applyAutoformat,
  applyDividerAutoformat,
  applyInlineFormat,
  childIndex,
  deleteBackward,
  getBlock,
  insertText,
  isCollapsed,
  marksAt,
  matchAutoformat,
  matchInlineFormat,
  mergeBackward,
  mergeForward,
  deleteTextSelection,
  resolveTextRange,
  plainText,
  splitBlock,
  textCaret,
  textLength,
  toggleChecked,
  toggleMarkRange,
  uuidv7,
} from '@nbe/core';
import type { EditorView } from './view';
import { domToModelPoint, leafOf } from './selection';
import { inEditableText } from './topology';
import { syncCaretFromDom } from './caret';
import { nextGrapheme, nextWord, prevWord } from '@nbe/core';
import { dismissedBy, openIconPicker } from './ui';

/**
 * The selected range when it lies in one block.
 *
 * @remarks
 * Delegates to `resolveTextRange` rather than recomputing min/max, because
 * that is where a range is put in document order *and* snapped off any
 * character it would otherwise bisect (AQ#4). Doing the arithmetic again here
 * meant the two disagreed: formatting over a range starting mid-emoji covered
 * the whole emoji, while typing over the same range left half a surrogate
 * behind.
 */
function singleBlockCaret(view: EditorView): { id: BlockId; from: number; to: number } | null {
  const range = resolveTextRange(view.editor);
  if (!range || !range.single) return null;
  return { id: range.startBlockId, from: range.startOffset, to: range.endOffset };
}

/**
 * One-shot break after an inline conversion: the next character typed at the
 * caret the conversion left stays plain (Notion), instead of continuing the
 * mark the delimiters just applied. Module-level, but keyed by exact
 * {block, offset}, which no other caret can occupy.
 */
let inlineBreak: { id: BlockId; offset: number } | null = null;

function handleInsertText(view: EditorView, data: string): void {
  const editor = view.editor;
  // typing over a cross-block selection replaces it, like any editor
  const range = resolveTextRange(editor);
  if (range && !range.single) {
    deleteTextSelection(editor);
    view.syncDomSelection();
    insertText(editor, data);
    return;
  }
  const at = singleBlockCaret(view);
  if (!at) return;
  const block = getBlock(editor.doc, at.id);
  const atBreak = inlineBreak?.id === at.id && inlineBreak.offset === at.from;
  inlineBreak = null;
  insertText(editor, data, atBreak ? undefined : marksAt(block.text, at.from));

  // markdown autoformat: check the text before the caret after insertion
  const after = getBlock(editor.doc, at.id);
  const before = plainText(after.text).slice(0, at.from + data.length);
  if (after.type === 'paragraph') {
    if (before === '---' && plainText(after.text) === '---') {
      applyDividerAutoformat(editor, at.id);
      return;
    }
    const rule = matchAutoformat(before, editor.plugins);
    if (rule) {
      applyAutoformat(editor, at.id, rule);
      return;
    }
  } else if (after.type === 'bulleted_list_item') {
    /*
     * `- [ ] ` is how Markdown spells a checklist, and the `- ` has already
     * turned this into a bullet by the time the `[ ] ` arrives — so the rule
     * has to be allowed to convert a bullet, or the Markdown spelling silently
     * left a bullet with `[ ] ` typed into it. Only a to-do may: `# ` inside a
     * list item is a heading nobody asked for.
     */
    const rule = matchAutoformat(before, editor.plugins);
    if (rule?.type === 'to_do') {
      applyAutoformat(editor, at.id, rule);
      return;
    }
  }
  if (after.type === 'code') return; // a code block holds literal text
  const inline = matchInlineFormat(before);
  if (inline) {
    applyInlineFormat(editor, at.id, inline);
    inlineBreak = { id: at.id, offset: inline.to - inline.prefix - inline.suffix };
  }
}

/**
 * The word and line deletes every text field has: `⌥⌫`, `⌥⌦`, `^K`, and
 * `Ctrl+⌫`/`Ctrl+⌦` off a Mac.
 *
 * @remarks
 * Every one of these used to fall through to the `default:` arm below and be
 * blocked outright — the standard editing keymap did nothing at all inside the
 * editor, which is what "il faut tout supporter" was about.
 *
 * The obvious implementation is to delete whatever `ev.getTargetRanges()` says
 * the browser was going to, since it computed the boundary already. Measured:
 * Chromium reports **zero** ranges for these input types, so the boundary has
 * to be ours. Words come from UAX #29 (`prevWord`/`nextWord`), which is right
 * in scripts that do not separate words with spaces.
 *
 * ponytail: a *soft* line is the visual one and a *hard* line is the one a
 * `\n` ends; both are treated as hard here, so a soft-line delete on a wrapped
 * paragraph takes the whole logical line. Measuring the visual line means
 * walking client rects, and the one key that produces it (`⌘⌫`) is claimed by
 * the keymap for deleting the block. Revisit if a host rebinds it.
 */
function handleDeleteBy(view: EditorView, inputType: string): void {
  const editor = view.editor;
  const range = resolveTextRange(editor);
  if (range && !range.single) {
    deleteTextSelection(editor);
    view.syncDomSelection();
    return;
  }
  const at = singleBlockCaret(view);
  if (!at) return;

  const plain = plainText(getBlock(editor.doc, at.id).text);
  let { from, to } = at;
  if (from === to) {
    const lineStart = plain.lastIndexOf('\n', from - 1) + 1;
    const nextBreak = plain.indexOf('\n', to);
    const lineEnd = nextBreak === -1 ? plain.length : nextBreak;
    if (inputType === 'deleteWordBackward') from = prevWord(plain, from);
    else if (inputType === 'deleteWordForward') to = nextWord(plain, to);
    else if (inputType === 'deleteEntireSoftLine') [from, to] = [lineStart, lineEnd];
    else if (inputType.endsWith('Backward')) from = lineStart;
    else to = lineEnd;
  }
  if (from === to) return;
  editor.dispatch((tx) => tx.op({ type: 'delete_text', id: at.id, from, to }), {
    origin: 'input',
    selection: textCaret(at.id, from),
  });
}

function handleDeleteForward(view: EditorView): void {
  const editor = view.editor;
  const at = singleBlockCaret(view);
  if (!at) return;
  if (at.from !== at.to) {
    editor.dispatch((tx) => tx.op({ type: 'delete_text', id: at.id, from: at.from, to: at.to }), {
      origin: 'input',
      selection: textCaret(at.id, at.from),
    });
    return;
  }
  const block = getBlock(editor.doc, at.id);
  const plain = plainText(block.text);
  if (at.from >= plain.length) {
    mergeForward(editor);
    return;
  }
  // one press, one perceived character — the same rule as Backspace (AQ#4)
  const end = nextGrapheme(plain, at.from);
  editor.dispatch(
    (tx) => tx.op({ type: 'delete_text', id: at.id, from: at.from, to: end }),
    { origin: 'input', selection: textCaret(at.id, at.from), coalesce: `typing:${at.id}` },
  );
}

/**
 * Reconcile the model from a leaf's DOM text via prefix/suffix diff. Used
 * after IME composition and when an extension edits text outside our pipeline
 * (never during composition — ARCHITECTURE §5.1).
 */
export function reconcileLeaf(view: EditorView, leaf: HTMLElement): void {
  const editor = view.editor;
  const id = leaf.dataset['blockId'];
  if (!id || !editor.doc.blocks.has(id)) return;
  const block = getBlock(editor.doc, id);
  const domText = leaf.textContent ?? '';
  const modelText = plainText(block.text);
  if (domText === modelText) return;

  let p = 0;
  const min = Math.min(domText.length, modelText.length);
  while (p < min && domText[p] === modelText[p]) p++;
  let s = 0;
  while (s < min - p && domText[domText.length - 1 - s] === modelText[modelText.length - 1 - s]) s++;
  const inserted = domText.slice(p, domText.length - s);

  editor.dispatch(
    (tx) => {
      if (modelText.length - s > p) tx.op({ type: 'delete_text', id, from: p, to: modelText.length - s });
      if (inserted) tx.op({ type: 'insert_text', id, offset: p, runs: [{ text: inserted, marks: marksAt(block.text, p) }] });
    },
    { origin: 'input', selection: textCaret(id, p + inserted.length), coalesce: `typing:${id}` },
  );
}

export function attachInput(view: EditorView): () => void {
  const editor = view.editor;
  const content = view.content;

  const onBeforeInput = (e: Event) => {
    const ev = e as InputEvent;
    if (view.composing) return; // browser owns the DOM during composition
    if (!inEditableText(ev.target as Node)) return; // UI inputs (image URL, menus) keep native behavior
    // the DOM caret is the truth — typing must land where the caret visibly is
    syncCaretFromDom(view);
    switch (ev.inputType) {
      case 'insertText':
        ev.preventDefault();
        handleInsertText(view, ev.data ?? '');
        break;
      case 'insertParagraph':
        ev.preventDefault();
        splitBlock(editor);
        break;
      case 'insertLineBreak':
        ev.preventDefault();
        handleInsertText(view, '\n');
        break;
      case 'deleteContentBackward':
      case 'deleteContentForward': {
        ev.preventDefault();
        const range = resolveTextRange(editor);
        if (range && !range.single) {
          deleteTextSelection(editor);
          view.syncDomSelection();
          break;
        }
        if (ev.inputType === 'deleteContentForward') handleDeleteForward(view);
        else if (!deleteBackward(editor)) mergeBackward(editor);
        break;
      }
      // the platform's own word/line deletes, honoured rather than blocked
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteSoftLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineBackward':
      case 'deleteHardLineForward':
      case 'deleteEntireSoftLine': {
        ev.preventDefault();
        handleDeleteBy(view, ev.inputType);
        break;
      }
      case 'insertReplacementText': {
        /*
         * What a browser fires when someone accepts a spellcheck correction, or
         * an autocorrect on a phone. It arrives with the misspelling already
         * selected and the replacement in `data`, which is exactly what
         * `handleInsertText` does with a range — so this is the existing path,
         * not a new one.
         *
         * It used to fall through to the default and be blocked outright:
         * right-clicking a typo and choosing the fix did nothing at all, in
         * every browser, with spellcheck on by default in a contenteditable.
         */
        ev.preventDefault();
        const replacement = ev.data ?? ev.dataTransfer?.getData('text/plain') ?? '';
        if (replacement) handleInsertText(view, replacement);
        break;
      }
      case 'insertFromPaste':
        ev.preventDefault(); // the 'paste' event pipeline in clipboard.ts owns pasting
        break;
      case 'insertFromDrop':
        ev.preventDefault();
        break;
      case 'formatBold':
        ev.preventDefault();
        toggleMarkRange(editor, 'bold');
        break;
      case 'formatItalic':
        ev.preventDefault();
        toggleMarkRange(editor, 'italic');
        break;
      case 'formatUnderline':
        ev.preventDefault();
        toggleMarkRange(editor, 'underline');
        break;
      case 'historyUndo':
        ev.preventDefault();
        editor.undo();
        break;
      case 'historyRedo':
        ev.preventDefault();
        editor.redo();
        break;
      case 'insertCompositionText':
        break; // non-cancelable by spec; reconciled at compositionend
      default:
        /*
         * ponytail: an input type this editor does not recognise is blocked
         * rather than let through — the model is the document, and a browser
         * writing into the DOM behind its back is the failure mode D2 exists to
         * avoid. The MutationObserver defence catches what slips past.
         *
         * `insertReplacementText` used to land here, which silently broke
         * accepting a spellcheck correction; it has its own case now.
         */
        ev.preventDefault();
    }
  };

  const onCompositionStart = () => {
    view.composing = true;
  };
  const onCompositionEnd = (e: Event) => {
    view.composing = false;
    const leaf = leafOf(e.target as Node);
    if (leaf) reconcileLeaf(view, leaf);
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const checkbox = target.closest('.nbe-checkbox');
    if (checkbox) {
      // same command the ⌘Enter binding runs, so click and keyboard cannot drift
      toggleChecked(editor, [(checkbox.closest('.nbe-block') as HTMLElement).dataset['blockId']!]);
      return;
    }
    const pageLink = target.closest('.nbe-t-link_to_page');
    if (pageLink) {
      const pageId = String(
        getBlock(editor.doc, (pageLink as HTMLElement).dataset['blockId']!).props['pageId'] ?? '',
      );
      if (pageId) view.options.onOpenPage?.(pageId);
      return;
    }
    const calloutIcon = target.closest('.nbe-callout-icon') as HTMLElement | null;
    if (calloutIcon) {
      if (dismissedBy(calloutIcon)) return; // toggle, not close-and-reopen
      const id = (calloutIcon.closest('.nbe-block') as HTMLElement).dataset['blockId']!;
      const current = String(getBlock(editor.doc, id).props['icon'] ?? '');
      openIconPicker(() => calloutIcon.getBoundingClientRect(), {
        current,
        storeImage: view.options.onStoreAsset,
        onPick: (icon) =>
          editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { icon } } }), { origin: 'ui' }),
        onRemove: () =>
          editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { icon: undefined } } }), {
            origin: 'ui',
          }),
      });
      return;
    }
    const arrow = target.closest('.nbe-toggle-arrow');
    if (arrow) {
      const id = (arrow.closest('.nbe-block') as HTMLElement).dataset['blockId']!;
      const collapsed = getBlock(editor.doc, id).props['collapsed'] === true;
      editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { collapsed: !collapsed } } }), {
        origin: 'ui',
      });
      return;
    }
    // Click in the empty page below the last block: append a paragraph (Notion).
    // A drag that ended here was a selection gesture, not a click to write —
    // the router swallows that synthetic click, so reaching here means a click.
    if (target === content && !view.gesture) {
      const root = getBlock(editor.doc, editor.doc.rootId);
      const lastId = root.children[root.children.length - 1];
      const last = lastId ? getBlock(editor.doc, lastId) : null;
      /*
       * *Below*, not merely "on the editor's own box". The side padding is
       * editor surface too (it holds the gutter and the Word-like margins), so
       * without this a click level with paragraph two appended a paragraph at
       * the end of the page — a document change nobody asked for.
       */
      const lastEl = lastId ? view.blockEl(lastId) : null;
      if (lastEl && e.clientY <= lastEl.getBoundingClientRect().bottom) return;
      if (last && last.type === 'paragraph' && textLength(last.text) === 0) {
        view.focusBlock(last.id, 0);
        return;
      }
      const p: Block = {
        id: uuidv7(),
        type: 'paragraph',
        version: 1,
        props: {},
        text: [],
        children: [],
        parentId: editor.doc.rootId,
      };
      editor.dispatch((tx) => tx.op({ type: 'insert_block', block: p, index: root.children.length }), {
        origin: 'ui',
        selection: textCaret(p.id, 0),
      });
    }
  };

  // keys typed into block chrome (drop zones, pickers) belong to that control
  const onUiKeydown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('[data-nbe-ui]')) e.stopPropagation();
  };

  content.addEventListener('beforeinput', onBeforeInput);
  content.addEventListener('compositionstart', onCompositionStart);
  content.addEventListener('compositionend', onCompositionEnd);
  content.addEventListener('click', onClick);
  content.addEventListener('keydown', onUiKeydown);
  return () => {
    content.removeEventListener('beforeinput', onBeforeInput);
    content.removeEventListener('compositionstart', onCompositionStart);
    content.removeEventListener('compositionend', onCompositionEnd);
    content.removeEventListener('click', onClick);
    content.removeEventListener('keydown', onUiKeydown);
  };
}

export { domToModelPoint };
