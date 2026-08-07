import type { BlockId } from '@nbe/core';

/**
 * Where a dragged block lands, computed from geometry alone.
 *
 * @remarks
 * This is deliberately a pure function over rectangles: no DOM, no editor, no
 * pointer events. Drop targeting is the part of dragging that has to feel
 * right, and "feels right" is a set of numbers — how wide the column band is,
 * how much the pointer may shake before the answer changes, what happens in
 * the gap between two blocks. Numbers belong in tests, not in a browser you
 * have to drag by hand.
 *
 * It also fixes the pitfall `docs/research/hard-interactions.md` names
 * explicitly (§8): the previous implementation asked `elementsFromPoint` what
 * was under the cursor, so margins, gaps and nested wrappers were dead zones
 * where the indicator vanished. Here every candidate is measured, and the
 * pointer always resolves to the nearest one — there is no gap to fall into.
 *
 * @category Interaction
 */

/** Where the drop lands relative to its target. `left`/`right` build columns. */
export type DropEdge = 'before' | 'after' | 'left' | 'right';

export interface DropTarget {
  id: BlockId;
  edge: DropEdge;
}

/** A block that can be dropped onto, reduced to what the geometry needs. */
export interface DropCandidate {
  id: BlockId;
  rect: { top: number; bottom: number; left: number; right: number };
}

export interface DropOptions {
  /**
   * Whether dropping beside a block creates a column. Off makes the editor
   * strictly a vertical list, which is what an embed usually wants — and the
   * side bands then cost nothing, since they are not drawn at all.
   */
  columns: boolean;
  /** The previous answer, so a shaky pointer does not flicker between two. */
  previous?: DropTarget | null;
}

/**
 * The side band, as a fraction of the block's width, clamped.
 *
 * @remarks
 * This number is why dragging felt broken. It used to be a quarter of the
 * width clamped to 140px, which on the demo's 612px column claimed 280px —
 * **46% of every block** was "make a column", so aiming for "move below" hit
 * a column instead. At 12% clamped to 64px it is 21%, and the four fifths in
 * the middle do what a drag usually means: reorder.
 */
const SIDE_RATIO = 0.12;
const SIDE_MIN = 28;
const SIDE_MAX = 64;

/** A block shorter or narrower than this has no room for a meaningful band. */
const MIN_SIDE_HEIGHT = 28;
const MIN_MIDDLE = 80;

/**
 * How far past a boundary the previous answer survives.
 *
 * @remarks
 * Capped at a quarter of the block for the vertical midpoint, because a
 * constant is wrong on short blocks: 16px of hysteresis on a 28px paragraph
 * pushes the effective midpoint outside the block entirely, so approaching it
 * from below made "drop above" unreachable. Measured by
 * `e2e/block-drag.spec.ts`, which is the test that found it.
 */
const STICKY = 16;

/** The side band for a block, or 0 when it is too small to carry one. */
function sideBand(rect: DropCandidate['rect']): number {
  const width = rect.right - rect.left;
  const band = Math.min(SIDE_MAX, Math.max(SIDE_MIN, width * SIDE_RATIO));
  if (rect.bottom - rect.top < MIN_SIDE_HEIGHT) return 0;
  return width - band * 2 >= MIN_MIDDLE ? band : 0;
}

/** Vertical distance from `y` to a rect: 0 when inside it. */
function distanceY(rect: DropCandidate['rect'], y: number): number {
  return y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
}

/**
 * The block a pointer is targeting.
 *
 * @remarks
 * Containment first, and the *smallest* container wins so a block nested in a
 * column takes precedence over the column. Failing that, the vertically
 * nearest block — that branch is what removes the dead zones: the pointer in
 * the gap between two paragraphs, in the page margin, or over the gutter still
 * has an answer.
 */
function nearest(candidates: DropCandidate[], x: number, y: number): DropCandidate | null {
  let best: DropCandidate | null = null;
  let bestArea = Infinity;
  for (const c of candidates) {
    if (y < c.rect.top || y > c.rect.bottom || x < c.rect.left || x > c.rect.right) continue;
    const area = (c.rect.bottom - c.rect.top) * (c.rect.right - c.rect.left);
    if (area < bestArea) {
      best = c;
      bestArea = area;
    }
  }
  if (best) return best;

  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distanceY(c.rect, y);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Resolve a pointer position to a drop target.
 *
 * @param candidates - Every block that may be dropped onto. The caller has
 * already excluded the dragged blocks and their descendants.
 * @returns `null` only when there is nothing to drop onto at all.
 */
export function resolveDrop(
  x: number,
  y: number,
  candidates: DropCandidate[],
  opts: DropOptions,
): DropTarget | null {
  const target = nearest(candidates, x, y);
  if (!target) return null;

  const { rect, id } = target;
  const held = opts.previous?.id === id ? opts.previous : null;

  if (opts.columns) {
    const band = sideBand(rect);
    if (band > 0) {
      // an engaged side keeps its grip a little past the band's edge
      const grow = (edge: DropEdge) => (held?.edge === edge ? STICKY : 0);
      if (x < rect.left + band + grow('left')) return { id, edge: 'left' };
      if (x > rect.right - band - grow('right')) return { id, edge: 'right' };
    }
  }

  const middle = (rect.top + rect.bottom) / 2;
  const grip = Math.min(STICKY, (rect.bottom - rect.top) / 4);
  const bias = held?.edge === 'before' ? grip : held?.edge === 'after' ? -grip : 0;
  return { id, edge: y < middle + bias ? 'before' : 'after' };
}
