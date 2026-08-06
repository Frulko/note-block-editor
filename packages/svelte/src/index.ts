import { Editor, createDoc, docFromJSON, docToJSON, type BlockJSON, type Change } from '@nbe/core';
import { EditorView, type EditorViewOptions } from '@nbe/dom';

/**
 * Svelte binding: a use: action, which is the idiomatic thin mount and needs
 * no compilation (so this package stays plain TS like the others — a .svelte
 * component would drag a compiler into the SDK for no added capability).
 *
 *   <div use:blockEditor={{ initialContent, onChange }} />
 */

export interface BlockEditorActionOptions extends EditorViewOptions {
  initialContent?: BlockJSON;
  onChange?: (doc: BlockJSON, change: Change) => void;
  onReady?: (editor: Editor) => void;
}

export interface BlockEditorAction {
  update(options: BlockEditorActionOptions): void;
  destroy(): void;
}

export function blockEditor(node: HTMLElement, options: BlockEditorActionOptions = {}): BlockEditorAction {
  // latest options without re-mounting: the view owns the document, so
  // rebuilding it on every prop change would destroy caret and history
  let latest = options;
  const editor = new Editor({
    doc: options.initialContent ? docFromJSON(options.initialContent) : createDoc(),
  });
  const view = new EditorView(node, editor, {
    onOpenPage: (id) => latest.onOpenPage?.(id),
    onCreatePage: () => latest.onCreatePage?.() ?? null,
    onStoreAsset: latest.onStoreAsset ? (blob) => latest.onStoreAsset!(blob) : undefined,
    resolveAssetUrl: latest.resolveAssetUrl ? (src) => latest.resolveAssetUrl!(src) : undefined,
    database: latest.database,
  });
  const off = editor.on((change) => latest.onChange?.(docToJSON(editor.doc), change));
  options.onReady?.(editor);

  return {
    update(next) {
      latest = next;
    },
    destroy() {
      off();
      view.destroy();
    },
  };
}

/** Imperative helper for hosts that manage their own container. */
export function createBlockEditor(
  node: HTMLElement,
  options: BlockEditorActionOptions = {},
): { editor: Editor; destroy: () => void } {
  const editor = new Editor({
    doc: options.initialContent ? docFromJSON(options.initialContent) : createDoc(),
  });
  const view = new EditorView(node, editor, options);
  const off = editor.on((change) => options.onChange?.(docToJSON(editor.doc), change));
  options.onReady?.(editor);
  return {
    editor,
    destroy() {
      off();
      view.destroy();
    },
  };
}

export type { Editor, BlockJSON, EditorViewOptions };
