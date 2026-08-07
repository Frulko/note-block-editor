// @vitest-environment happy-dom
//
// §2.4 keeps three constructs apart: a sub-page is a block, a link-to-page is
// an alias block, and a mention is a rich-text span resolving the LIVE title.
// That last property is the whole design, so it is what these pin.
import { describe, expect, it, vi } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { mentionRuns, MENTION_MARK } from '../src/mention';

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    {
      id: 'p',
      type: 'paragraph',
      version: 1,
      text: [
        { text: 'voir ' },
        { text: 'Ancien titre', marks: [{ type: MENTION_MARK, attrs: { pageId: 'page-1' } }] },
      ],
    },
  ],
};

function mount(options: ConstructorParameters<typeof EditorView>[2] = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), options);
  return { view, destroy: () => { view.destroy(); container.remove(); } };
}

describe('a mention resolves its title at render time', () => {
  it('shows the current title, not the one stored when it was inserted', () => {
    const t = mount({ resolvePageTitle: () => 'Nouveau titre' });
    expect(t.view.content.querySelector('.nbe-m-mention')?.textContent).toBe('Nouveau titre');
    t.destroy();
  });

  it('falls back to the stored text when the host cannot resolve', () => {
    // an unloaded workspace or a static export: readable text beats nothing
    const t = mount();
    expect(t.view.content.querySelector('.nbe-m-mention')?.textContent).toBe('Ancien titre');
    t.destroy();
  });

  it('marks a deleted page as unresolved rather than hiding it', () => {
    const t = mount({ resolvePageTitle: () => null });
    const el = t.view.content.querySelector('.nbe-m-mention')!;
    expect(el.textContent).toBe('Ancien titre');
    expect(el.classList.contains('nbe-m-mention-missing')).toBe(true);
    t.destroy();
  });

  it('carries the page id, so a click can route without parsing text', () => {
    const t = mount({ resolvePageTitle: () => 'X' });
    expect(t.view.content.querySelector<HTMLElement>('.nbe-m-mention')?.dataset['pageId']).toBe('page-1');
    t.destroy();
  });

  it('asks the host once per mention, with the id it stored', () => {
    const resolve = vi.fn(() => 'X');
    const t = mount({ resolvePageTitle: resolve });
    expect(resolve).toHaveBeenCalledWith('page-1');
    t.destroy();
  });
});

describe('what a chosen mention inserts', () => {
  it('is the title marked as a mention, plus a trailing space', () => {
    const runs = mentionRuns({ pageId: 'p1', title: 'Ma page' });
    expect(runs[0]).toEqual({ text: 'Ma page', marks: [{ type: 'mention', attrs: { pageId: 'p1' } }] });
    expect(runs[1]).toEqual({ text: ' ' });
  });
});

describe('the @ trigger', () => {
  it('is inert without a host to search, since an empty autocomplete is worse than none', () => {
    const t = mount();
    const leaf = t.view.content.querySelector('.nbe-leaf')!;
    leaf.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '@' }));
    expect(document.querySelector('.nbe-mention-menu')).toBeNull();
    t.destroy();
  });
});
