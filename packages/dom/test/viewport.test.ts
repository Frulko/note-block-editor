// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachViewportGuard, reveal } from '../src/viewport';
import type { EditorView } from '../src/view';

/**
 * Keeping the caret above the software keyboard.
 *
 * @remarks
 * The keyboard itself needs a device. Its *effect* does not: it shrinks
 * `visualViewport` and changes nothing else, so the decision this module makes
 * — is the caret hidden, and by how much — is entirely simulable, and it was
 * the last untested path in the mobile story.
 *
 * The behaviour worth protecting is the restraint. Scrolling on every resize
 * would fight the user during pinch-zoom, which resizes the visual viewport
 * too, so the guard must move only when the caret is genuinely hidden.
 */

type Viewport = { height: number; offsetTop: number; addEventListener: unknown; removeEventListener: unknown };

const listeners = new Set<() => void>();
let scrolled: number[] = [];

/** A visual viewport of `height`, as the keyboard leaves one. */
function fakeViewport(height: number): Viewport {
  return {
    height,
    offsetTop: 0,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
}

/** A view whose caret sits with its bottom edge at `caretBottom`. */
function fakeView(caretBottom: number | null): EditorView {
  const content = document.createElement('div');
  document.body.append(content);
  const leaf = document.createElement('p');
  leaf.textContent = 'bonjour';
  content.append(leaf);

  if (caretBottom !== null) {
    const range = { cloneRange: () => range, collapse: () => {}, getClientRects: () => [{ bottom: caretBottom }] };
    vi.spyOn(document, 'getSelection').mockReturnValue({
      rangeCount: 1,
      focusNode: leaf.firstChild,
      getRangeAt: () => range,
    } as unknown as Selection);
  } else {
    vi.spyOn(document, 'getSelection').mockReturnValue({ rangeCount: 0 } as unknown as Selection);
  }
  return { content } as unknown as EditorView;
}

function fire(): void {
  for (const fn of [...listeners]) fn();
}

afterEach(() => {
  listeners.clear();
  scrolled = [];
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function install(height: number) {
  Object.defineProperty(window, 'visualViewport', { value: fakeViewport(height), configurable: true });
  window.scrollBy = ((opts: { top: number }) => {
    scrolled.push(opts.top);
  }) as unknown as typeof window.scrollBy;
  window.requestAnimationFrame = ((fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
}

describe('the caret stays above the keyboard', () => {
  it('scrolls by exactly what is hidden, plus the margin', () => {
    install(400); // the keyboard took the bottom half
    const stop = attachViewportGuard(fakeView(500)); // caret 100px below the fold
    fire();
    // 500 + 24 margin - 400 visible = 124
    expect(scrolled).toEqual([124]);
    stop();
  });

  it('leaves the page alone when the caret is already visible', () => {
    // the restraint that keeps pinch-zoom from fighting the user: a resize
    // with a visible caret must move nothing at all
    install(400);
    const stop = attachViewportGuard(fakeView(200));
    fire();
    expect(scrolled).toEqual([]);
    stop();
  });

  it('does nothing without a caret', () => {
    install(400);
    const stop = attachViewportGuard(fakeView(null));
    fire();
    expect(scrolled).toEqual([]);
    stop();
  });

  it('stops listening when detached', () => {
    install(400);
    const stop = attachViewportGuard(fakeView(500));
    stop();
    fire();
    expect(scrolled).toEqual([]);
  });

  it('is a no-op where visualViewport does not exist', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    expect(() => attachViewportGuard(fakeView(500))()).not.toThrow();
  });
});

/**
 * `reveal` moves one scroller.
 *
 * @remarks
 * The whole point of the function, and the half that `scrollIntoView` was
 * still undoing: a caret genuinely below the fold used to scroll the document's
 * scroller *and* every scrollable ancestor above it — which inside Obsidian is
 * the pane, the split and the window. Two scrollers is the smallest arrangement
 * where that is visible at all, so that is what this builds.
 */
describe('reveal scrolls the scrollport the block is in, and nothing above it', () => {
  /** A div that `findScrollParent` will accept: overflow, and content to scroll. */
  function scrollable(parent: Element, rect: { top: number; bottom: number }): HTMLElement {
    const el = document.createElement('div');
    el.style.overflowY = 'auto';
    Object.defineProperty(el, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: rect.bottom - rect.top, configurable: true });
    el.getBoundingClientRect = () => ({ ...rect, height: rect.bottom - rect.top }) as DOMRect;
    parent.append(el);
    return el;
  }

  function block(parent: Element, rect: { top: number; bottom: number }): HTMLElement {
    const box = document.createElement('div');
    const leaf = document.createElement('p');
    leaf.getBoundingClientRect = () => ({ ...rect, height: rect.bottom - rect.top }) as DOMRect;
    box.append(leaf);
    parent.append(box);
    return leaf;
  }

  it('scrolls the inner scroller only, by the distance that was hidden', () => {
    const outer = scrollable(document.body, { top: 0, bottom: 800 });
    const inner = scrollable(outer, { top: 100, bottom: 500 });
    const leaf = block(inner, { top: 560, bottom: 580 });
    const into = vi.spyOn(leaf, 'scrollIntoView');

    reveal(leaf);

    expect(inner.scrollTop).toBe(80); // 580 bottom - 500 port bottom
    expect(outer.scrollTop).toBe(0);
    expect(into).not.toHaveBeenCalled();
  });

  it('brings a block above the port back down to its top edge', () => {
    const inner = scrollable(document.body, { top: 100, bottom: 500 });
    inner.scrollTop = 300;
    const leaf = block(inner, { top: 40, bottom: 60 });

    reveal(leaf);

    expect(inner.scrollTop).toBe(240); // 300 + (40 - 100)
  });

  it('does not touch a scroller showing the block already', () => {
    const inner = scrollable(document.body, { top: 100, bottom: 500 });
    inner.scrollTop = 300;
    const leaf = block(inner, { top: 200, bottom: 220 });

    reveal(leaf);

    expect(inner.scrollTop).toBe(300);
  });
});
