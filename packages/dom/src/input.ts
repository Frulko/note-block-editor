import type { Block, BlockId } from '@nbe/core';
import {
  applyAutoformat,
  applyDividerAutoformat,
  childIndex,
  deleteBackward,
  getBlock,
  insertText,
  isCollapsed,
  marksAt,
  matchAutoformat,
  mergeBackward,
  mergeForward,
  deleteTextSelection,
  resolveTextRange,
  plainText,
  splitBlock,
  textCaret,
  textLength,
  toggleMarkRange,
  uuidv7,
} from '@nbe/core';
import type { EditorView } from './view';
import { domToModelPoint, leafOf } from './selection';
import { syncCaretFromDom } from './caret';
import { dismissedBy, openIconPicker } from './ui';
import { justRubberBanded } from './rubberband';

function singleBlockCaret(view: EditorView): { id: BlockId; from: number; to: number } | null {
  const sel = view.editor.selection;
  if (sel?.kind !== 'text' || sel.anchor.blockId !== sel.head.blockId) return null;
  return {
    id: sel.anchor.blockId,
    from: Math.min(sel.anchor.offset, sel.head.offset),
    to: Math.max(sel.anchor.offset, sel.head.offset),
  };
}

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
  insertText(editor, data, marksAt(block.text, at.from));

  // markdown autoformat: check the text before the caret after insertion
  const after = getBlock(editor.doc, at.id);
  if (after.type !== 'paragraph') return;
  const before = plainText(after.text).slice(0, at.from + data.length);
  if (before === '---' && plainText(after.text) === '---') {
    applyDividerAutoformat(editor, at.id);
    return;
  }
  const rule = matchAutoformat(before);
  if (rule) applyAutoformat(editor, at.id, rule);
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
  const code = plain.charCodeAt(at.from);
  const step = code >= 0xd800 && code <= 0xdbff && at.from + 2 <= plain.length ? 2 : 1;
  editor.dispatch(
    (tx) => tx.op({ type: 'delete_text', id: at.id, from: at.from, to: at.from + step }),
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
    if (!leafOf(ev.target as Node)) return; // UI inputs (image URL, menus) keep native behavior
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
        // ponytail: unknown input types are blocked to protect the model;
        // insertReplacementText (spellcheck) support comes with the MutationObserver path
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
      const id = (checkbox.closest('.nbe-block') as HTMLElement).dataset['blockId']!;
      const checked = getBlock(editor.doc, id).props['checked'] === true;
      editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { checked: !checked } } }), {
        origin: 'ui',
      });
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
    // click in the empty area below the last block: append a paragraph (Notion).
    // A drag that ended here was a selection gesture, not a click to write.
    if (target === content && !view.blockGesture && !justRubberBanded()) {
      const root = getBlock(editor.doc, editor.doc.rootId);
      const lastId = root.children[root.children.length - 1];
      const last = lastId ? getBlock(editor.doc, lastId) : null;
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
