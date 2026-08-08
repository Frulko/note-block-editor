// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachViewportGuard } from '../src/viewport';
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
