import { describe, expect, it } from 'vitest';
import { computePosition } from '../src/ui/position';

const viewport = { width: 1000, height: 800 };
const size = { width: 240, height: 300 };
const anchor = (top: number, left: number, w = 200, h = 24) => ({
  top,
  left,
  right: left + w,
  bottom: top + h,
});

describe('computePosition', () => {
  it('places below the anchor when there is room', () => {
    const pos = computePosition(anchor(100, 50), size, viewport, { placement: 'bottom-start' });
    expect(pos).toEqual({ top: 130, left: 50, placement: 'bottom-start' });
  });

  it('flips above when the bottom overflows and the top fits', () => {
    const pos = computePosition(anchor(700, 50), size, viewport, { placement: 'bottom-start' });
    expect(pos.placement).toBe('top-start');
    expect(pos.top).toBe(700 - 300 - 6);
  });

  it('clamps instead of flipping when neither side fits', () => {
    const pos = computePosition(anchor(400, 50), { width: 240, height: 900 }, viewport, {
      placement: 'bottom-start',
    });
    expect(pos.top).toBe(8); // pinned to padding
  });

  it('clamps horizontally inside the viewport', () => {
    const pos = computePosition(anchor(100, 900), size, viewport, { placement: 'bottom-start' });
    expect(pos.left).toBe(1000 - 240 - 8);
  });

  it('end alignment right-aligns to the anchor', () => {
    const pos = computePosition(anchor(100, 300), size, viewport, { placement: 'bottom-end' });
    expect(pos.left).toBe(300 + 200 - 240);
  });

  it('left placement flips to the right when it overflows', () => {
    const pos = computePosition(anchor(100, 30), size, viewport, { placement: 'left-start' });
    expect(pos.placement).toBe('right-start');
    expect(pos.left).toBe(30 + 200 + 6);
  });

  it('honors custom offset and padding', () => {
    const pos = computePosition(anchor(100, 50), size, viewport, {
      placement: 'bottom-start',
      offset: 12,
      padding: 20,
    });
    expect(pos.top).toBe(124 + 12);
  });
});
