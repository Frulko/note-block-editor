// @vitest-environment happy-dom
//
// The configuration surface: what a host can change without forking. Each
// test here corresponds to a gap the audit measured — twelve hardwired
// features, no read-only mode, 76 hardcoded French strings, and a token layer
// that was complete but not reachable from JavaScript.
import { describe, expect, it, vi } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { defaultFeatures, minimalFeatures, type EditorFeature } from '../src/features';
import { defaultLabels } from '../src/labels';

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

function mount(options: ConstructorParameters<typeof EditorView>[2] = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), options);
  return { view, destroy: () => { view.destroy(); container.remove(); } };
}

describe('features', () => {
  it('attaches the default set when nothing is asked for', () => {
    // the observable contract is that editing works — the input feature is in
    // the default list, and beforeinput is intercepted rather than ignored
    const t = mount();
    const leaf = t.view.content.querySelector('.nbe-leaf')!;
    const range = document.createRange();
    range.setStart(leaf.firstChild!, 7);
    range.collapse(true);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '!' });
    leaf.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    t.destroy();
  });

  it('leaves input untouched when no feature is attached', () => {
    const t = mount({ features: [] });
    const leaf = t.view.content.querySelector('.nbe-leaf')!;
    const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '!' });
    leaf.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    t.destroy();
  });

  it('attaches only what is listed', () => {
    const attached: string[] = [];
    const spy = (name: string): EditorFeature => ({
      name,
      attach: () => {
        attached.push(name);
        return () => {};
      },
    });
    const t = mount({ features: [spy('a'), spy('b')] });
    expect(attached).toEqual(['a', 'b']);
    t.destroy();
  });

  it('still renders the document with no features attached', () => {
    const t = mount({ features: [] });
    expect(t.view.content.querySelector('.nbe-leaf')?.textContent).toBe('bonjour');
    t.destroy();
  });

  it('detaches every feature on destroy', () => {
    const detach = vi.fn();
    const t = mount({ features: [{ name: 'x', attach: () => detach }] });
    t.destroy();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('ships a minimal set that still edits but has no chrome', () => {
    const names = minimalFeatures.map((f) => f.name);
    expect(names).toContain('input');
    expect(names).toContain('keymap');
    expect(names).not.toContain('slash-menu');
    expect(names).not.toContain('gutter');
  });

  it('names every default feature, so a host can filter by name', () => {
    expect(new Set(defaultFeatures.map((f) => f.name)).size).toBe(defaultFeatures.length);
  });
});

describe('read-only', () => {
  it('renders the document without a caret anywhere', () => {
    const t = mount({ readOnly: true });
    const leaf = t.view.content.querySelector('.nbe-leaf')!;
    expect(leaf.textContent).toBe('bonjour');
    expect(leaf.getAttribute('contenteditable')).toBeNull();
    expect(t.view.content.getAttribute('contenteditable')).toBeNull();
    t.destroy();
  });

  it('is not focusable, so Tab never lands in a surface that ignores keys', () => {
    const t = mount({ readOnly: true });
    expect(t.view.content.hasAttribute('tabindex')).toBe(false);
    t.destroy();
  });

  it('attaches no features by default', () => {
    const t = mount({ readOnly: true });
    expect(document.querySelector('.nbe-controls')).toBeNull();
    t.destroy();
  });

  it('exposes the choice for CSS and for callers', () => {
    const t = mount({ readOnly: true });
    expect(t.view.readOnly).toBe(true);
    expect(t.view.content.dataset['readonly']).toBe('');
    t.destroy();
  });
});

describe('labels', () => {
  it('defaults to the shipped dictionary', () => {
    const t = mount();
    expect(t.view.labels.bold).toBe(defaultLabels.bold);
    t.destroy();
  });

  it('merges a partial override, so a host translates what it needs', () => {
    const t = mount({ labels: { bold: 'Bold', delete: 'Delete' } });
    expect(t.view.labels.bold).toBe('Bold');
    expect(t.view.labels.delete).toBe('Delete');
    expect(t.view.labels.italic).toBe(defaultLabels.italic); // untouched
    t.destroy();
  });
});

describe('theme', () => {
  it('sets custom properties on the editor root', () => {
    const t = mount({ theme: { '--nbe-accent-rgb': '220 38 38' } });
    expect(t.view.content.style.getPropertyValue('--nbe-accent-rgb')).toBe('220 38 38');
    t.destroy();
  });

  it('accepts keys written without the -- prefix', () => {
    const t = mount({ theme: { 'nbe-radius': '2px' } });
    expect(t.view.content.style.getPropertyValue('--nbe-radius')).toBe('2px');
    t.destroy();
  });
});

describe('spellcheck', () => {
  it('is off unless asked for, because a block editor is not a text area', () => {
    const t = mount();
    expect(t.view.content.spellcheck).toBe(false);
    t.destroy();
  });

  it('turns on when asked', () => {
    const t = mount({ spellcheck: true });
    expect(t.view.content.spellcheck).toBe(true);
    t.destroy();
  });
});

/**
 * The gutters are lists, so the tests are about what ends up in one. The hover
 * has to be staged: a gutter is only in the DOM while the pointer is near a
 * block, which is the whole point of it.
 */
describe('the hover gutters', () => {
  const hover = (t: ReturnType<typeof mount>) => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
    return (side: 'left' | 'right'): string[] => {
      const selector = side === 'left' ? '.nbe-controls:not(.nbe-controls-right)' : '.nbe-controls-right';
      const el = t.view.content.querySelector(selector);
      return [...(el?.querySelectorAll('button') ?? [])].map((b) => b.className.replace('nbe-ctrl-btn ', ''));
    };
  };

  it('gives the left one the + and the handle, and the right one nothing', () => {
    const t = mount();
    const buttons = hover(t);
    expect(buttons('left')).toEqual(['nbe-plus', 'nbe-handle']);
    // the comment button is dropped rather than rendered dead
    expect(buttons('right')).toEqual([]);
    t.destroy();
  });

  it('adds the comment button once a host can receive it', () => {
    const t = mount({ onComment: () => {} });
    expect(hover(t)('right')).toEqual(['nbe-comment']);
    t.destroy();
  });

  it('hands the block and the author to the host, null when nobody is named', () => {
    const seen: Array<[string, unknown]> = [];
    const anonymous = mount({ onComment: (id, author) => seen.push([id, author]) });
    hover(anonymous)('right');
    (anonymous.view.content.querySelector('.nbe-comment') as HTMLButtonElement).click();
    anonymous.destroy();

    const author = { id: 'u1', name: 'Alice' };
    const named = mount({ onComment: (id, a) => seen.push([id, a]), commentAuthor: author });
    hover(named)('right');
    (named.view.content.querySelector('.nbe-comment') as HTMLButtonElement).click();
    named.destroy();

    expect(seen).toEqual([['a', null], ['a', author]]);
  });

  it('takes a custom action, and lets a side be emptied', () => {
    const t = mount({
      gutter: { left: [], right: [{ name: 'approve', icon: 'check', title: 'Valider', onClick: () => {} }] },
    });
    const buttons = hover(t);
    expect(buttons('left')).toEqual([]);
    expect(buttons('right')).toEqual(['nbe-ctrl-approve']);
    t.destroy();
  });
});
