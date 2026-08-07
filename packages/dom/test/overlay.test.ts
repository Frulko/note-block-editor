// @vitest-environment happy-dom
//
// The overlay stack is what makes dismissal predictable. Every case here was
// broken by the previous per-overlay `dismissable()`: Escape was a broadcast,
// and each overlay judged "outside" alone, so nesting dismissed the parent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetOverlays, closeAllOverlays, dismissedBy, openOverlays, pushOverlay } from '../src/ui/overlay';

let closed: string[] = [];

function overlay(name: string, opts: { exempt?: Node; escape?: boolean } = {}) {
  const el = document.createElement('div');
  el.dataset['name'] = name;
  document.body.append(el);
  const pop = pushOverlay({
    el,
    escape: opts.escape,
    exempt: opts.exempt ? (t) => opts.exempt!.contains(t) : undefined,
    close: () => {
      closed.push(name);
      el.remove();
    },
  });
  return { el, pop };
}

const press = (target: Node) =>
  target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
const escape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

beforeEach(() => {
  closed = [];
  __resetOverlays();
  document.body.replaceChildren();
});
afterEach(() => __resetOverlays());

describe('escape', () => {
  it('closes the top overlay only', () => {
    overlay('popover');
    overlay('menu');
    escape();
    expect(closed).toEqual(['menu']);
    expect(openOverlays()).toHaveLength(1);
  });

  it('walks back down one level per press', () => {
    overlay('popover');
    overlay('menu');
    escape();
    escape();
    expect(closed).toEqual(['menu', 'popover']);
    expect(openOverlays()).toHaveLength(0);
  });

  it('is consumed, so a keymap below never sees it', () => {
    overlay('menu');
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves the stack alone when the top opts out', () => {
    overlay('modal', { escape: false });
    escape();
    expect(closed).toEqual([]);
  });

  it('does nothing when nothing is open', () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('outside press', () => {
  it('closes everything when the press is outside the whole stack', () => {
    overlay('popover');
    overlay('menu');
    press(document.body);
    expect(closed).toEqual(['menu', 'popover']);
  });

  it('keeps a parent open when the press lands inside it', () => {
    // the exact nesting bug: a menu opened from a popover must not take the
    // popover down with it when the user clicks back into the popover
    const parent = overlay('popover');
    overlay('menu');
    press(parent.el);
    expect(closed).toEqual(['menu']);
    expect(openOverlays()).toHaveLength(1);
  });

  it('ignores a press inside the top overlay', () => {
    const top = overlay('menu');
    press(top.el);
    expect(closed).toEqual([]);
  });

  it('treats an exempt node as inside', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    overlay('menu', { exempt: trigger });
    press(trigger);
    expect(closed).toEqual([]);
  });
});

describe('trigger toggling', () => {
  it('reports the press that dismissed, so a trigger can bail instead of reopening', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    overlay('menu');
    press(trigger);
    expect(closed).toEqual(['menu']);
    expect(dismissedBy(trigger)).toBe(true);
  });

  it('does not report an unrelated node', () => {
    const trigger = document.createElement('button');
    const other = document.createElement('button');
    document.body.append(trigger, other);
    overlay('menu');
    press(other);
    expect(dismissedBy(trigger)).toBe(false);
  });

  it('does not report a press that landed inside an overlay', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const parent = overlay('popover');
    overlay('menu');
    press(parent.el);
    expect(dismissedBy(trigger)).toBe(false);
  });
});

describe('lifecycle', () => {
  it('pops without closing when the overlay closes itself', () => {
    const o = overlay('menu');
    o.pop();
    expect(openOverlays()).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('survives a close() that throws', () => {
    const el = document.createElement('div');
    document.body.append(el);
    pushOverlay({ el, close: () => { throw new Error('boom'); } });
    overlay('menu');
    press(document.body);
    // the throwing entry still left the stack, and the other one still closed
    expect(openOverlays()).toHaveLength(0);
    expect(closed).toEqual(['menu']);
  });

  it('detaches its listeners once the stack empties', () => {
    const o = overlay('menu');
    o.pop();
    // with no listener attached, a stray Escape must not be consumed
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('closeAllOverlays empties the stack top-down', () => {
    overlay('a');
    overlay('b');
    closeAllOverlays();
    expect(closed).toEqual(['b', 'a']);
  });
});

describe('escape opt-out for form controls', () => {
  it('leaves Escape to a control that claims it', () => {
    const o = overlay('menu');
    const input = document.createElement('input');
    input.setAttribute('data-nbe-escape-self', '');
    o.el.append(input);
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(closed).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('still closes when the claiming control is in another overlay', () => {
    const parent = overlay('popover');
    const input = document.createElement('input');
    input.setAttribute('data-nbe-escape-self', '');
    parent.el.append(input);
    overlay('menu');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(closed).toEqual(['menu']);
  });

  it('closes for an ordinary field, so a search box does not trap Escape', () => {
    const o = overlay('picker');
    const input = document.createElement('input');
    o.el.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(closed).toEqual(['picker']);
  });
});
