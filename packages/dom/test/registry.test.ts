// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
// the *DOM* plugin, from `dom.ts`. `index.ts` exports the static-renderer one,
// which contributes an HTML string and nothing to a live view.
import { callout } from '../../blocks-callout/src/dom';

/**
 * R3's done-condition, from `docs/design/plugin-refactor-plan.md`.
 *
 * @remarks
 * The plan states it exactly: *"two editors on one page can have different
 * block sets"*. R3 has been marked "in progress" since 2026-08-07, and the way
 * to find out whether it still is, is to try it.
 *
 * The point of a per-*editor* registry rather than a global one is that a
 * host embedding two editors — a document and a comment box, say — must be
 * able to give the comment box fewer blocks. A global registry makes that
 * impossible, and makes the bundle carry every block whether or not anything
 * uses it.
 */

const WITH_CALLOUT: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'c', type: 'callout', version: 1, props: { icon: '!' }, children: [] }],
};

function mount(blocks?: Parameters<typeof EditorView>[2] extends infer O ? O : never) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(WITH_CALLOUT) }), blocks ?? {});
  return { view, container, destroy: () => { view.destroy(); container.remove(); } };
}

describe('R3: the block registry is per editor', () => {
  it('two editors on one page can render the same document differently', () => {
    // one knows what a callout is; the other does not, and must not crash
    const rich = mount({ blocks: [callout] });
    const plain = mount({});

    /*
     * Not the `nbe-t-callout` class — that comes from `block.type` and is
     * present either way. The plugin's contribution is the *icon* it renders
     * inside, which is what an unregistered editor cannot produce.
     */
    expect(rich.container.querySelector('.nbe-callout-icon')).not.toBeNull();
    expect(plain.container.querySelector('.nbe-callout-icon')).toBeNull();
    // and the unknown block still renders — §4: never destroy what you cannot read
    expect(plain.container.querySelector('[data-block-id="c"]')).not.toBeNull();

    rich.destroy();
    plain.destroy();
  });

  it('registering a block in one editor does not leak into another', () => {
    /*
     * The failure a global registry produces: mount an editor with a plugin,
     * destroy it, mount a plain one, and the plugin is still there. It works in
     * a demo and surprises the first host that embeds two.
     */
    const rich = mount({ blocks: [callout] });
    rich.destroy();

    const plain = mount({});
    expect(plain.container.querySelector('.nbe-callout-icon')).toBeNull();
    plain.destroy();
  });
});
