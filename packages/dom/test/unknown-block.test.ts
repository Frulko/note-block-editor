// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';

/**
 * A document that names a block type no plugin claims — the ordinary case for
 * a vault opened in a host with a smaller plugin set than the one that wrote
 * it, and what `@nbe/markdown`'s `<!-- nbe:type -->` marker now parses back to.
 *
 * The model keeps such a block on purpose (§4). Before, the renderer asked the
 * schema for its spec and threw, so one unloaded plugin took down the whole
 * page — the loudest possible way to lose a document that was never damaged.
 */
const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    { id: 'a', type: 'paragraph', version: 1, text: [{ text: 'avant' }] },
    {
      id: 'b',
      type: 'bookmark_wat',
      version: 1,
      props: { url: 'https://x.test' },
      children: [{ id: 'c', type: 'paragraph', version: 1, text: [{ text: 'dedans' }] }],
    },
    { id: 'd', type: 'paragraph', version: 1, text: [{ text: 'après' }] },
  ],
};

describe('a block whose plugin is not registered', () => {
  it('renders as an unrecognised block, with the page around it intact', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), {});

    const unknown = view.content.querySelector<HTMLElement>('.nbe-t-unknown');
    expect(unknown, 'the block is rendered, not dropped').not.toBeNull();
    expect(unknown!.dataset['unknownType']).toBe('bookmark_wat');
    expect(unknown!.textContent).toContain('bookmark_wat');
    // its content is still shown, and the blocks around it still rendered
    expect(unknown!.textContent).toContain('dedans');
    expect(view.content.textContent).toContain('avant');
    expect(view.content.textContent).toContain('après');

    view.destroy();
    container.remove();
  });
});
