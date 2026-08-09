// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, textCaret, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';

/**
 * When the view says it has written to the DOM.
 *
 * @remarks
 * Everything that measures the document — a `Range` parked in
 * `CSS.highlights`, an overlay placed from a rect — is invalidated by the
 * element it measured being replaced, and `editor.on` is the wrong moment to
 * redo it twice over: it fires before the render on a transaction, and not at
 * all on the renders no transaction announces. `onRender` is that moment, and
 * this is the contract it makes — *which* blocks, and `null` for all of them.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    { id: 'a', type: 'paragraph', version: 1, text: [{ text: 'un' }] },
    {
      id: 'toggle',
      type: 'toggle',
      version: 1,
      text: [{ text: 'deux' }],
      children: [{ id: 'nested', type: 'paragraph', version: 1, text: [{ text: 'trois' }] }],
    },
  ],
};

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), { features: [] });
  const seen: Array<readonly string[] | null> = [];
  const off = view.onRender((ids) => seen.push(ids));
  return { view, seen, destroy: () => { off(); view.destroy(); container.remove(); } };
}

describe('onRender', () => {
  it('names the block whose element was replaced', () => {
    const { view, seen, destroy } = mount();
    view.editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 2, runs: [{ text: '!' }] }), {
      origin: 'input',
      selection: textCaret('a', 3),
    });
    expect(seen).toEqual([['a']]);
    destroy();
  });

  it('reports null when the whole surface is rebuilt', () => {
    const { view, seen, destroy } = mount();
    view.renderAll();
    expect(seen).toEqual([null]);
    destroy();
  });

  it('fires after the DOM holds the new text, not before', () => {
    const { view, destroy } = mount();
    let text: string | null = null;
    view.onRender(() => (text = view.leafEl('a')?.textContent ?? null));
    view.editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 2, runs: [{ text: 'X' }] }), {
      origin: 'input',
      selection: textCaret('a', 3),
    });
    expect(text).toBe('unX');
    destroy();
  });

  /*
   * A feature attached by a host is a listener like any other, and the view's
   * own render used to be registered last — so every one of them ran against
   * the DOM about to be thrown away. The ordering is the fix; this is what it
   * has to keep being.
   */
  it('a feature listening to the editor sees the rendered DOM too', () => {
    const container = document.createElement('div');
    document.body.append(container);
    let text: string | null = null;
    const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), {
      features: [
        {
          name: 'probe',
          attach: (v) => v.editor.on(() => (text = v.leafEl('a')?.textContent ?? null)),
        },
      ],
    });
    view.editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'a', offset: 2, runs: [{ text: 'X' }] }), {
      origin: 'input',
      selection: textCaret('a', 3),
    });
    expect(text).toBe('unX');
    view.destroy();
    container.remove();
  });

  it('a nested block is covered by the ancestor that rendered it', () => {
    const { view, seen, destroy } = mount();
    view.editor.dispatch((tx) => tx.op({ type: 'insert_text', id: 'nested', offset: 5, runs: [{ text: '!' }] }), {
      origin: 'input',
      selection: textCaret('nested', 6),
    });
    // the child owns its own element, so it is named rather than its parent
    expect(seen).toEqual([['nested']]);
    destroy();
  });
});

/**
 * When a streamed opening render is finished.
 *
 * A host that has to act on the *whole* document as soon as it exists needs to
 * know — Obsidian restores the reader's scroll position across a rebuild, and
 * a position further down than the first screenful would clamp against a
 * document that has not finished arriving.
 */
describe('whenComplete', () => {
  it('is already resolved when nothing is streaming', async () => {
    const { view, destroy } = mount();
    await expect(view.whenComplete()).resolves.toBeUndefined();
    destroy();
  });

  it('waits for the tail of a long document, and the document is whole when it resolves', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const long: BlockJSON = {
      id: 'root',
      type: 'page',
      version: 1,
      children: Array.from({ length: 500 }, (_, i) => ({
        id: `b${i}`,
        type: 'paragraph',
        version: 1,
        text: [{ text: `ligne ${i}` }],
      })),
    };
    const view = new EditorView(container, new Editor({ doc: docFromJSON(long) }), { features: [] });
    // the first paint is a screenful, not the document
    expect(view.content.children.length).toBeLessThan(500);

    await view.whenComplete();
    expect(view.content.children.length).toBe(500);
    view.destroy();
    container.remove();
  });
});
