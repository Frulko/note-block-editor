// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caretFromClientPoint } from '../src/caret';

/**
 * A caret lookup that checks its own answer.
 *
 * `caretPositionFromPoint` takes viewport coordinates by specification, and
 * WebKit has long treated them as document ones — a caret that is right at the
 * top of a page and drifts as it scrolls. Reported from the desktop build,
 * invisible to every browser test because Chromium follows the specification.
 */

const original = {
  position: (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint,
  range: (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint,
};

afterEach(() => {
  Object.assign(document, { caretPositionFromPoint: original.position, caretRangeFromPoint: original.range });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  vi.restoreAllMocks();
});

/** A text node whose caret rectangles we control. */
function stubbedNode(rectFor: (offset: number) => { top: number; bottom: number; height: number }) {
  const node = document.createTextNode('bonjour tout le monde');
  document.body.append(node);
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const box = rectFor(this.startOffset);
    return { ...box, left: 0, right: 10, width: 10, x: 0, y: box.top, toJSON: () => ({}) } as DOMRect;
  });
  return node;
}

describe('a lookup that lands where it was asked', () => {
  it('is used as is', () => {
    const node = stubbedNode(() => ({ top: 100, bottom: 118, height: 18 }));
    Object.assign(document, {
      caretPositionFromPoint: () => ({ offsetNode: node, offset: 7 }),
      caretRangeFromPoint: undefined,
    });
    expect(caretFromClientPoint(50, 108)).toEqual({ node, offset: 7 });
  });

  it('tolerates a click a line above or below', () => {
    const node = stubbedNode(() => ({ top: 100, bottom: 118, height: 18 }));
    Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: node, offset: 3 }) });
    // between two lines still counts: the alternative is rejecting a good answer
    expect(caretFromClientPoint(50, 88)).toEqual({ node, offset: 3 });
  });
});

describe('a lookup that reads the point as a document coordinate', () => {
  it('is retried with the scroll added, and the corrected answer wins', () => {
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true, writable: true });
    // the engine answers as though the page were not scrolled: asked about
    // viewport y=108 it returns the position at document y=108, which is 500px
    // above where the user clicked
    const node = stubbedNode((offset) => (offset === 4 ? { top: 100, bottom: 118, height: 18 } : { top: -400, bottom: -382, height: 18 }));
    Object.assign(document, {
      caretPositionFromPoint: (_x: number, y: number) => ({ offsetNode: node, offset: y > 500 ? 4 : 9 }),
    });

    expect(caretFromClientPoint(50, 108)).toEqual({ node, offset: 4 });
  });

  it('does not retry when the page is not scrolled', () => {
    const node = stubbedNode(() => ({ top: -400, bottom: -382, height: 18 }));
    const lookup = vi.fn(() => ({ offsetNode: node, offset: 2 }));
    Object.assign(document, { caretPositionFromPoint: lookup });
    caretFromClientPoint(50, 108);
    // nothing to correct by, so one call and no guessing
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('when nothing verifies', () => {
  it('returns the direct answer rather than nothing', () => {
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true, writable: true });
    const node = stubbedNode(() => ({ top: -900, bottom: -882, height: 18 }));
    Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: node, offset: 1 }) });
    // an imperfect caret beats no caret: the click must still do something
    expect(caretFromClientPoint(50, 108)).toEqual({ node, offset: 1 });
  });

  it('returns null when the engine offers nothing at all', () => {
    Object.assign(document, { caretPositionFromPoint: () => null, caretRangeFromPoint: () => null });
    expect(caretFromClientPoint(50, 108)).toBeNull();
  });
});
