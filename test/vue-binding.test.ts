// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { useEditor } from '../packages/vue/src/index';
import type { BlockJSON } from '../packages/core/src/doc';
import type { Editor } from '../packages/core/src/editor';

/**
 * The Vue binding, second of three that shipped untested.
 *
 * @remarks
 * `useEditor` is a composable built on `onMounted`, so unlike the Svelte action
 * it genuinely needs a component to run inside. Vue resolves from the root
 * already, so that costs a `createApp` and no new dependency.
 *
 * What is worth checking is the same thing as for Svelte, in Vue's idiom: the
 * editor is created once on mount, reaches the template ref, and is torn down
 * when the app unmounts. A binding that leaked its view would keep a
 * `selectionchange` listener alive for the life of the page.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

/** Mount a component using the composable, and hand back what it produced. */
function mount(options: Parameters<typeof useEditor>[0] = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  let result: ReturnType<typeof useEditor> | null = null;

  const app = createApp(
    defineComponent({
      setup() {
        result = useEditor(options);
        return () => h('div', { ref: result!.containerRef });
      },
    }),
  );
  app.mount(host);
  return { app, host, result: result!, cleanup: () => { app.unmount(); host.remove(); } };
}

describe('the Vue composable', () => {
  it('attaches an editor to the template ref on mount', () => {
    const { host, result, cleanup } = mount({ initialContent: DOC });
    expect(result.editor.value).not.toBeNull();
    expect(host.textContent).toContain('bonjour');
    cleanup();
  });

  it('reports changes with the serialized document', () => {
    const onChange = vi.fn();
    const { result, cleanup } = mount({ initialContent: DOC, onChange });
    const editor = result.editor.value as Editor;

    editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 7, runs: [{ text: ' !' }] }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onChange.mock.calls[0]![0])).toContain('bonjour !');
    cleanup();
  });

  it('stops reporting once the component unmounts', () => {
    /*
     * A binding that leaked its view would keep a document-level
     * `selectionchange` listener alive for the life of the page, and go on
     * calling a callback belonging to a component that no longer exists.
     */
    const onChange = vi.fn();
    const { result, cleanup } = mount({ initialContent: DOC, onChange });
    const editor = result.editor.value as Editor;
    cleanup();

    editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 0, runs: [{ text: 'X' }] }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onReady with the editor it created', () => {
    const onReady = vi.fn();
    const { result, cleanup } = mount({ initialContent: DOC, onReady });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]![0]).toBe(result.editor.value);
    cleanup();
  });
});
