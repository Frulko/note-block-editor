// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, textCaret, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';

/**
 * What an edit is allowed to throw away.
 *
 * @remarks
 * An `<iframe>` reloads the page it is showing whenever it is re-created *or*
 * re-parented, and an `<img>` flashes while it decodes again — so "the same
 * element is still there afterwards" is not a performance detail here, it is
 * the difference between a video that keeps playing and one that restarts.
 *
 * Every assertion below is about **node identity**: the same object, not an
 * equal one. That is the only thing the browser's reload rule looks at.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    { id: 'a', type: 'paragraph', version: 1, text: [{ text: 'un' }] },
    { id: 'img', type: 'image', version: 1, props: { src: 'x.png', width: 100 } },
    { id: 'c', type: 'paragraph', version: 1, text: [{ text: 'trois' }] },
  ],
};

function mount(doc: BlockJSON = DOC) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(doc) }), { features: [] });
  return { view, destroy: () => (view.destroy(), container.remove()) };
}

describe('an edit keeps the elements it did not change', () => {
  it('inserting a top-level block leaves its siblings standing', () => {
    const { view, destroy } = mount();
    const before = [view.blockEl('a'), view.blockEl('img'), view.blockEl('c')];
    view.editor.dispatch(
      (tx) =>
        tx.op({
          type: 'insert_block',
          block: { id: 'new', type: 'paragraph', version: 1, props: {}, children: [], parentId: 'root', text: [] },
          index: 1,
        }),
      { origin: 'ui', selection: textCaret('new', 0) },
    );
    expect([view.blockEl('a'), view.blockEl('img'), view.blockEl('c')]).toEqual(before);
    expect([...view.content.children].map((el) => (el as HTMLElement).dataset['blockId'])).toEqual([
      'a',
      'new',
      'img',
      'c',
    ]);
    destroy();
  });

  it('reordering moves the element rather than building another one', () => {
    const { view, destroy } = mount();
    const img = view.blockEl('img')!.querySelector('img');
    view.editor.dispatch((tx) => tx.op({ type: 'move_block', id: 'img', parentId: 'root', after: null }), {
      origin: 'ui',
    });
    expect([...view.content.children].map((el) => (el as HTMLElement).dataset['blockId'])).toEqual(['img', 'a', 'c']);
    expect(view.blockEl('img')!.querySelector('img')).toBe(img);
    destroy();
  });

  it('deleting one removes exactly one', () => {
    const { view, destroy } = mount();
    const a = view.blockEl('a');
    view.editor.dispatch((tx) => tx.op({ type: 'delete_block', id: 'c' }), { origin: 'ui' });
    expect([...view.content.children].map((el) => (el as HTMLElement).dataset['blockId'])).toEqual(['a', 'img']);
    expect(view.blockEl('a')).toBe(a);
    destroy();
  });

  it('sizing a media block rebuilds its box and keeps what is loaded inside it', () => {
    const { view, destroy } = mount();
    const img = view.blockEl('img')!.querySelector('img');
    view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: 'img', patch: { props: { width: 50 } } }), {
      origin: 'ui',
    });
    const figure = view.blockEl('img')!.querySelector<HTMLElement>('.nbe-figure')!;
    expect(figure.style.width).toBe('50%');
    expect(figure.querySelector('img')).toBe(img); // the same node: no second load
    destroy();
  });

  it('a different source is a different node, and does load', () => {
    const { view, destroy } = mount();
    const img = view.blockEl('img')!.querySelector('img');
    view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: 'img', patch: { props: { src: 'y.png' } } }), {
      origin: 'ui',
    });
    expect(view.blockEl('img')!.querySelector('img')).not.toBe(img);
    destroy();
  });
});

/**
 * A number is a fact about the siblings, so it is the one thing a moved
 * element cannot bring with it — and the reconcile no longer rebuilds the
 * neighbours that would have re-counted for free.
 */
describe('numbered lists re-count after a move', () => {
  const LIST: BlockJSON = {
    id: 'root',
    type: 'page',
    version: 1,
    children: [
      { id: 'l1', type: 'numbered_list_item', version: 1, text: [{ text: 'un' }] },
      { id: 'l2', type: 'numbered_list_item', version: 1, text: [{ text: 'deux' }] },
      { id: 'l3', type: 'numbered_list_item', version: 1, text: [{ text: 'trois' }] },
    ],
  };
  const numbers = (view: EditorView) =>
    [...view.content.querySelectorAll('.nbe-number')].map((el) => el.textContent);

  it('the third item dragged to the top is 1., not 3.', () => {
    const { view, destroy } = mount(LIST);
    expect(numbers(view)).toEqual(['1.', '2.', '3.']);
    view.editor.dispatch((tx) => tx.op({ type: 'move_block', id: 'l3', parentId: 'root', after: null }), {
      origin: 'ui',
    });
    expect([...view.content.children].map((el) => (el as HTMLElement).dataset['blockId'])).toEqual(['l3', 'l1', 'l2']);
    expect(numbers(view)).toEqual(['1.', '2.', '3.']);
    destroy();
  });
});
