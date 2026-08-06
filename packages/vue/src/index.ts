import { defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, type PropType, type Ref } from 'vue';
import { Editor, createDoc, docFromJSON, docToJSON, type BlockJSON, type Change } from '@nbe/core';
import { EditorView, type EditorViewOptions } from '@nbe/dom';

/**
 * Vue binding: a thin mount (ARCHITECTURE §9) — lifecycle, projection, and
 * hosting the DOM view. No editing logic here.
 */

export interface UseEditorOptions extends EditorViewOptions {
  initialContent?: BlockJSON;
  onChange?: (doc: BlockJSON, change: Change) => void;
  onReady?: (editor: Editor) => void;
}

export interface UseEditorResult {
  editor: Ref<Editor | null>;
  containerRef: Ref<HTMLElement | null>;
}

/** Composable: attach an editor to a template ref. */
export function useEditor(options: UseEditorOptions = {}): UseEditorResult {
  const containerRef = ref<HTMLElement | null>(null);
  const editor = shallowRef<Editor | null>(null);
  let view: EditorView | null = null;
  let off: (() => void) | null = null;

  onMounted(() => {
    const container = containerRef.value;
    if (!container) return;
    const instance = new Editor({
      doc: options.initialContent ? docFromJSON(options.initialContent) : createDoc(),
    });
    view = new EditorView(container, instance, {
      onOpenPage: options.onOpenPage,
      onCreatePage: options.onCreatePage,
      onStoreAsset: options.onStoreAsset,
      resolveAssetUrl: options.resolveAssetUrl,
      database: options.database,
    });
    off = instance.on((change) => options.onChange?.(docToJSON(instance.doc), change));
    editor.value = instance;
    options.onReady?.(instance);
  });

  onBeforeUnmount(() => {
    off?.();
    view?.destroy();
    view = null;
    editor.value = null;
  });

  return { editor, containerRef };
}

/** Drop-in component. Import '@nbe/dom/style.css' for the default look. */
export const BlockEditor = defineComponent({
  name: 'BlockEditor',
  props: {
    initialContent: { type: Object as PropType<BlockJSON>, default: undefined },
    options: { type: Object as PropType<EditorViewOptions>, default: () => ({}) },
  },
  emits: {
    change: (_doc: BlockJSON, _change: Change) => true,
    ready: (_editor: Editor) => true,
  },
  setup(props, { emit }) {
    const { containerRef } = useEditor({
      ...props.options,
      initialContent: props.initialContent,
      onChange: (doc, change) => emit('change', doc, change),
      onReady: (editor) => emit('ready', editor),
    });
    return () => h('div', { ref: containerRef });
  },
});

export type { Editor, BlockJSON, EditorViewOptions };
