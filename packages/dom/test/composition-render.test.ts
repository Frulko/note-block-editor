// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, getBlock, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';

/**
 * A remote edit that arrives while someone is composing.
 *
 * @remarks
 * §5.1's rule is usually stated as "never mutate the DOM mid-composition", and
 * every path that *writes* has honoured it from the start. `renderAll` is the
 * one that does not come from the input path at all: a peer's edit reaches it
 * from the network, and rebuilding the surface under a half-typed word
 * destroys the composition — the text vanishes and the IME is left pointing at
 * nothing.
 *
 * The fix is deferral rather than refusal: the update is owed, and it lands the
 * moment the word is committed. Dropping it would be the other way to be
 * wrong.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), {});
  return { view, destroy: () => { view.destroy(); container.remove(); } };
}

/** What a peer's edit does to the model, without going through this editor. */
function remoteEdit(view: EditorView, text: string): void {
  const block = getBlock(view.editor.doc, 'a');
  view.editor.doc.blocks.set('a', { ...block, text: [{ text }] });
}

describe('renderAll during composition', () => {
  it('leaves the surface alone while an IME is composing', () => {
    const { view, destroy } = mount();
    const leaf = view.content.querySelector('.nbe-leaf')!;
    // the composition's own text is in the DOM and not yet in the model
    leaf.textContent = 'bonjour にほ';

    view.composing = true;
    remoteEdit(view, 'écrit par un pair');
    view.renderAll();

    expect(leaf.textContent, 'the composed text must survive').toBe('bonjour にほ');
    destroy();
  });

  it('pays the render back the moment composition ends', () => {
    const { view, destroy } = mount();
    view.composing = true;
    remoteEdit(view, 'écrit par un pair');
    view.renderAll();

    view.composing = false;
    expect(view.content.textContent).toContain('écrit par un pair');
    destroy();
  });

  it('owes at most one render, however many arrive', () => {
    const { view, destroy } = mount();
    view.composing = true;
    for (const text of ['un', 'deux', 'trois']) {
      remoteEdit(view, text);
      view.renderAll();
    }
    view.composing = false;
    // the last state, once — a queue of renders would repaint three times
    expect(view.content.textContent).toContain('trois');
    expect(view.content.querySelectorAll('.nbe-leaf')).toHaveLength(1);
    destroy();
  });

  it('renders immediately when nothing is composing', () => {
    const { view, destroy } = mount();
    remoteEdit(view, 'sans composition');
    view.renderAll();
    expect(view.content.textContent).toContain('sans composition');
    destroy();
  });
});
