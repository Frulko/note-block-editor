// @vitest-environment happy-dom
//
// A tooltip hides on `mouseleave`. An element removed from the document never
// fires one — and the chrome these are attached to is removed all the time: the
// gutter hides when the pointer leaves a block, a toolbar rebuilds, a menu
// closes. So the pointer moved away, the button vanished, no event arrived, and
// the label sat in the margin pointing at nothing.
//
// Reported 2026-08-10 with a screenshot of « Commenter ce bloc » alone below an
// empty gutter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTooltip } from '../src/ui/tooltip';

const tips = () => document.querySelectorAll('.nbe-tooltip').length;

/** Run the frame the watcher scheduled. happy-dom's rAF is a timer. */
const frame = async () => {
  await vi.advanceTimersByTimeAsync(32);
};

let button: HTMLElement;
let detach: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  button = document.createElement('button');
  document.body.append(button);
  detach = attachTooltip(button, 'Commenter ce bloc', { delayMs: 10 });
});

afterEach(() => {
  detach();
  vi.useRealTimers();
});

/** Hover and let the delay elapse. */
async function hover() {
  button.dispatchEvent(new Event('mouseenter'));
  await vi.advanceTimersByTimeAsync(20);
}

describe('a tooltip goes away when it should', () => {
  it('appears after the delay, and not before', async () => {
    button.dispatchEvent(new Event('mouseenter'));
    await vi.advanceTimersByTimeAsync(5);
    expect(tips()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(tips()).toBe(1);
  });

  it('goes on mouseleave, which is the ordinary path', async () => {
    await hover();
    expect(tips()).toBe(1);
    button.dispatchEvent(new Event('mouseleave'));
    expect(tips()).toBe(0);
  });

  it('goes when its target is removed — no mouseleave is ever fired', async () => {
    await hover();
    expect(tips()).toBe(1);

    // exactly what hiding the gutter does, and what left the label stranded
    button.remove();
    expect(button.isConnected).toBe(false);

    await frame();
    expect(tips()).toBe(0);
  });

  it('goes when an ancestor is removed, not only the target itself', async () => {
    const gutter = document.createElement('div');
    document.body.append(gutter);
    const inner = document.createElement('button');
    gutter.append(inner);
    const off = attachTooltip(inner, 'Ajouter un bloc', { delayMs: 10 });

    inner.dispatchEvent(new Event('mouseenter'));
    await vi.advanceTimersByTimeAsync(20);
    expect(tips()).toBe(1);

    gutter.remove(); // `controls.remove()`, which is how this really happens
    await frame();
    expect(tips()).toBe(0);
    off();
  });

  it('stops watching once hidden, rather than spinning a frame loop forever', async () => {
    await hover();
    button.dispatchEvent(new Event('mouseleave'));
    const spy = vi.spyOn(globalThis, 'requestAnimationFrame');
    await frame();
    await frame();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('detaching takes the tooltip with it', async () => {
    await hover();
    expect(tips()).toBe(1);
    detach();
    expect(tips()).toBe(0);
  });
});
