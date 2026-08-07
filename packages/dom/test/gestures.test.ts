// @vitest-environment happy-dom
//
// Arbitration used to be an accident of attach order, coordinated through
// three wall-clock windows. These tests pin it as state: one press has one
// owner, the router publishes what is running, and a gesture that moved
// swallows its own trailing click.
import { describe, expect, it, vi } from 'vitest';
import { Editor, createDoc } from '@nbe/core';
import { EditorView } from '../src/view';
import { attachGestureRouter, type GestureRecognizer } from '../src/gestures';

function harness(recognizers: GestureRecognizer[]) {
  const container = document.createElement('div');
  document.body.append(container);
  // no default recognizers: this harness is testing the router, not the set
  const view = new EditorView(container, new Editor({ doc: createDoc() }), { recognizers: [] });
  const stop = attachGestureRouter(view, recognizers);
  return {
    view,
    press: (init: PointerEventInit = {}) =>
      view.content.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10, ...init }),
      ),
    move: (x = 100, y = 100) =>
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y })),
    up: () => window.dispatchEvent(new PointerEvent('pointerup', {})),
    escape: () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    destroy: () => {
      stop();
      view.destroy();
      container.remove();
    },
  };
}

const rec = (name: string, opts: Partial<GestureRecognizer> & { mode?: 'text' | 'block'; log?: string[] } = {}) => {
  const log = opts.log ?? [];
  return {
    name,
    match: opts.match ?? (() => true),
    start:
      opts.start ??
      (() => {
        log.push(`${name}:start`);
        return {
          mode: opts.mode ?? 'text',
          move: () => log.push(`${name}:move`),
          end: (c: boolean) => log.push(`${name}:end:${c}`),
        };
      }),
  } as GestureRecognizer;
};

describe('arbitration', () => {
  it('gives the press to the first matching recognizer only', () => {
    const log: string[] = [];
    const h = harness([rec('first', { log }), rec('second', { log })]);
    h.press();
    expect(log).toEqual(['first:start']);
    expect(h.view.gesture?.name).toBe('first');
    h.destroy();
  });

  it('skips a recognizer whose match is false', () => {
    const log: string[] = [];
    const h = harness([rec('no', { log, match: () => false }), rec('yes', { log })]);
    h.press();
    expect(log).toEqual(['yes:start']);
    h.destroy();
  });

  it('falls through when a matching recognizer declines by returning null', () => {
    const log: string[] = [];
    const h = harness([rec('declines', { log, start: () => null }), rec('takes', { log })]);
    h.press();
    expect(log).toEqual(['takes:start']);
    h.destroy();
  });

  it('leaves the press to native behaviour when nothing claims it', () => {
    const h = harness([rec('no', { match: () => false })]);
    h.press();
    expect(h.view.gesture).toBeNull();
    h.destroy();
  });

  it('ignores non-primary buttons', () => {
    const h = harness([rec('any')]);
    h.press({ button: 2 });
    expect(h.view.gesture).toBeNull();
    h.destroy();
  });

  it('refuses to start a second gesture while one is running', () => {
    const log: string[] = [];
    const h = harness([rec('one', { log })]);
    h.press();
    h.press();
    expect(log).toEqual(['one:start']);
    h.destroy();
  });
});

describe('published state', () => {
  it('exposes the running gesture and its mode, then clears it', () => {
    const h = harness([rec('band', { mode: 'block' })]);
    h.press();
    expect(h.view.gesture).toMatchObject({ name: 'band', mode: 'block', moved: false });
    h.up();
    expect(h.view.gesture).toBeNull();
    h.destroy();
  });

  it('records that the pointer moved', () => {
    const h = harness([rec('drag')]);
    h.press();
    h.move();
    expect(h.view.gesture?.moved).toBe(true);
    h.destroy();
  });
});

describe('lifecycle', () => {
  it('ends committed on pointerup', () => {
    const log: string[] = [];
    const h = harness([rec('g', { log })]);
    h.press();
    h.up();
    expect(log).toContain('g:end:true');
    h.destroy();
  });

  it('ends uncommitted on Escape, and consumes the key', () => {
    const log: string[] = [];
    const h = harness([rec('g', { log })]);
    h.press();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(log).toContain('g:end:false');
    expect(e.defaultPrevented).toBe(true);
    h.destroy();
  });

  it('ends uncommitted on pointercancel and on window blur', () => {
    for (const fire of [
      () => window.dispatchEvent(new PointerEvent('pointercancel', {})),
      () => window.dispatchEvent(new Event('blur')),
    ]) {
      const log: string[] = [];
      const h = harness([rec('g', { log })]);
      h.press();
      fire();
      expect(log).toContain('g:end:false');
      h.destroy();
    }
  });

  it('ends the session when the router is detached mid-gesture', () => {
    const log: string[] = [];
    const h = harness([rec('g', { log })]);
    h.press();
    h.destroy();
    expect(log).toContain('g:end:false');
  });

  it('survives a recognizer that throws while moving', () => {
    const h = harness([
      {
        name: 'bad',
        match: () => true,
        start: () => ({ mode: 'text', move: () => { throw new Error('boom'); } }),
      },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.press();
    h.move();
    expect(h.view.gesture).toBeNull(); // released, not stuck in gesture state
    spy.mockRestore();
    h.destroy();
  });
});

describe('trailing click', () => {
  it('swallows the click after a gesture that moved', () => {
    const h = harness([rec('drag')]);
    const seen = vi.fn();
    document.addEventListener('click', seen);
    h.press();
    h.move();
    h.up();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener('click', seen);
    h.destroy();
  });

  it('lets the click through after a press that did not move', () => {
    const h = harness([rec('tap')]);
    const seen = vi.fn();
    document.addEventListener('click', seen);
    h.press();
    h.up();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', seen);
    h.destroy();
  });

  it('swallows exactly one click, not every click that follows', () => {
    const h = harness([rec('drag')]);
    const seen = vi.fn();
    document.addEventListener('click', seen);
    h.press();
    h.move();
    h.up();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toHaveBeenCalledTimes(1);
    document.removeEventListener('click', seen);
    h.destroy();
  });
});
