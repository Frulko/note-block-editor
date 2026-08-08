// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { blockEditor } from '../packages/svelte/src/index';
import type { BlockJSON } from '../packages/core/src/doc';

/**
 * The Svelte binding, which had no tests.
 *
 * @remarks
 * All three bindings shipped untested. This one is reachable without a
 * framework runtime — a Svelte action is a plain function taking a DOM node —
 * so it is the one that can be checked here, and the contract it verifies is
 * the shared one R7 established.
 *
 * The behaviour that matters is the comment in the source: *"latest options
 * without re-mounting: the view owns the document, so rebuilding it on every
 * prop change would destroy caret and history"*. A binding that re-mounts on
 * every prop change is the classic failure of this layer, and it is invisible
 * until someone types.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

function host() {
  const node = document.createElement('div');
  document.body.append(node);
  return node;
}

describe('the Svelte action', () => {
  it('mounts an editor showing the initial content', () => {
    const node = host();
    const action = blockEditor(node, { initialContent: DOC });
    expect(node.textContent).toContain('bonjour');
    action.destroy();
  });

  it('reports changes through onChange with the serialized document', () => {
    const node = host();
    const onChange = vi.fn();
    let captured: import('../packages/core/src/editor').Editor | null = null;
    const action = blockEditor(node, {
      initialContent: DOC,
      onChange,
      onReady: (editor) => (captured = editor),
    });

    captured!.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 7, runs: [{ text: ' !' }] }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onChange.mock.calls[0]![0])).toContain('bonjour !');
    action.destroy();
  });

  it('update() swaps the callbacks without re-mounting the editor', () => {
    /*
     * The whole reason the action keeps a `latest` reference. Re-creating the
     * view on a prop change would throw away the caret, the selection and the
     * undo history — and a Svelte component re-runs its action on every
     * reactive update, so this would happen constantly.
     */
    const node = host();
    let captured: import('../packages/core/src/editor').Editor | null = null;
    const first = vi.fn();
    const action = blockEditor(node, { initialContent: DOC, onChange: first, onReady: (e) => (captured = e) });
    const editorBefore = captured;

    const second = vi.fn();
    action.update({ initialContent: DOC, onChange: second });

    captured!.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 0, runs: [{ text: 'X' }] }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    // the same editor instance throughout: no remount
    expect(captured).toBe(editorBefore);
    action.destroy();
  });

  it('destroy() stops reporting changes', () => {
    const node = host();
    const onChange = vi.fn();
    let captured: import('../packages/core/src/editor').Editor | null = null;
    const action = blockEditor(node, { initialContent: DOC, onChange, onReady: (e) => (captured = e) });
    action.destroy();

    captured!.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 0, runs: [{ text: 'X' }] }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts from an empty document when given no content', () => {
    const node = host();
    const action = blockEditor(node);
    expect(node.querySelector('.nbe-editor')).not.toBeNull();
    action.destroy();
  });
});
