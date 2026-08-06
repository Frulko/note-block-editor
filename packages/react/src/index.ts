import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, RefObject } from 'react';
import { Editor, createDoc, docFromJSON, docToJSON, type BlockJSON, type Change } from '@nbe/core';
import { EditorView, type EditorViewOptions } from '@nbe/dom';

/**
 * React binding: a thin mount, per ARCHITECTURE §9. It does exactly three
 * jobs — lifecycle/ownership, state projection, and hosting the DOM view.
 * All editing logic lives in @nbe/core and @nbe/dom; this file must never
 * grow editor behavior.
 */

export interface UseEditorOptions extends EditorViewOptions {
  /** Initial document (uncontrolled: the editor owns it after mount). */
  initialContent?: BlockJSON;
  /** Called after every transaction with the serialized document. */
  onChange?: (doc: BlockJSON, change: Change) => void;
  /** Called once the editor and its view are mounted. */
  onReady?: (editor: Editor) => void;
}

export interface UseEditorResult {
  editor: Editor | null;
  ref: RefObject<HTMLDivElement | null>;
}

/**
 * Mount an editor into a container ref. The document is uncontrolled by
 * design: React re-renders never rebuild the view (that would destroy the
 * caret and history), so `initialContent` is read once at mount.
 */
export function useEditor(options: UseEditorOptions = {}): UseEditorResult {
  const ref = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // latest callbacks without re-mounting the view
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const initial = latest.current.initialContent;
    const instance = new Editor({ doc: initial ? docFromJSON(initial) : createDoc() });
    const view = new EditorView(container, instance, {
      onOpenPage: (id) => latest.current.onOpenPage?.(id),
      onCreatePage: () => latest.current.onCreatePage?.() ?? null,
      onStoreAsset: latest.current.onStoreAsset ? (blob) => latest.current.onStoreAsset!(blob) : undefined,
      resolveAssetUrl: latest.current.resolveAssetUrl ? (src) => latest.current.resolveAssetUrl!(src) : undefined,
      database: latest.current.database,
    });
    const off = instance.on((change) => latest.current.onChange?.(docToJSON(instance.doc), change));
    setEditor(instance);
    latest.current.onReady?.(instance);
    return () => {
      off();
      view.destroy();
      setEditor(null);
    };
  }, []);

  return { editor, ref };
}

export interface BlockEditorProps extends UseEditorOptions {
  className?: string;
  style?: CSSProperties;
}

/** Drop-in editor component. Import '@nbe/dom/style.css' for the default look. */
export function BlockEditor({ className, style, ...options }: BlockEditorProps): ReactElement {
  const { ref } = useEditor(options);
  return createElement('div', { ref, className, style });
}

export type { Editor, BlockJSON, EditorViewOptions };
