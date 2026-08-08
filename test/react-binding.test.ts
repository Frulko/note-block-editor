// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useEditor } from '../packages/react/src/index';
import type { BlockJSON } from '../packages/core/src/doc';
import type { Editor } from '../packages/core/src/editor';

/**
 * The React binding, last of the three that shipped untested.
 *
 * @remarks
 * The claim under test is the one in the hook's own doc comment: *"React
 * re-renders never rebuild the view (that would destroy the caret and history),
 * so `initialContent` is read once at mount"*. React re-renders for any reason
 * at all — a parent's state, a context change — so a binding that rebuilt on
 * each one would be unusable, and would look like the *editor's* fault rather
 * than the binding's.
 *
 * `createElement` and `act()` rather than a testing library: react-dom already
 * resolves here, JSX would need the file to be `.tsx` (which the suite does not
 * collect), and the extra dependency would buy nothing this file needs.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

function mount(options: Parameters<typeof useEditor>[0] = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  let captured: ReturnType<typeof useEditor> | null = null;
  let rerender: (() => void) | null = null;

  const Probe = () => {
    const [, tick] = useState(0);
    rerender = () => tick((n) => n + 1);
    captured = useEditor(options);
    return createElement('div', { ref: captured.ref });
  };

  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return {
    host,
    get result() {
      return captured!;
    },
    rerender: () => act(() => rerender!()),
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('the React hook', () => {
  it('mounts an editor showing the initial content', () => {
    const app = mount({ initialContent: DOC });
    expect(app.result.editor).not.toBeNull();
    expect(app.host.textContent).toContain('bonjour');
    app.cleanup();
  });

  it('a re-render does not rebuild the editor', () => {
    // the claim in the hook's doc comment, and what makes it usable at all
    const app = mount({ initialContent: DOC });
    const before = app.result.editor;
    app.rerender();
    app.rerender();
    expect(app.result.editor).toBe(before);
    app.cleanup();
  });

  it('reports changes with the serialized document', () => {
    const onChange = vi.fn();
    const app = mount({ initialContent: DOC, onChange });
    const editor = app.result.editor as Editor;

    act(() => {
      editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 7, runs: [{ text: ' !' }] }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onChange.mock.calls[0]![0])).toContain('bonjour !');
    app.cleanup();
  });

  it('stops reporting once unmounted', () => {
    const onChange = vi.fn();
    const app = mount({ initialContent: DOC, onChange });
    const editor = app.result.editor as Editor;
    app.cleanup();

    editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 0, runs: [{ text: 'X' }] }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
