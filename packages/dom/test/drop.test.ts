import { describe, expect, it } from 'vitest';
import { resolveDrop, type DropCandidate } from '../src/drop';

/**
 * The numbers that decide how dragging feels, pinned.
 *
 * Reported 2026-08-07 as "n'importe quoi, l'éditeur est non fonctionnel": the
 * side band claimed 46% of every block, so aiming to reorder produced a column
 * instead, and `elementsFromPoint` left dead zones in every gap.
 */

const rect = (top: number, bottom: number, left = 0, right = 612) => ({ top, bottom, left, right });
const a: DropCandidate = { id: 'a', rect: rect(0, 100) };
const b: DropCandidate = { id: 'b', rect: rect(120, 220) };
const all = [a, b];

describe('the middle of a block reorders', () => {
  it('gives before above the midpoint and after below it', () => {
    expect(resolveDrop(306, 20, all, { columns: true })).toEqual({ id: 'a', edge: 'before' });
    expect(resolveDrop(306, 80, all, { columns: true })).toEqual({ id: 'a', edge: 'after' });
  });

  it('leaves four fifths of the width to reordering', () => {
    // 612px wide: a 64px band each side, so 10%..90% must all reorder
    for (const f of [0.12, 0.25, 0.5, 0.75, 0.88]) {
      expect(resolveDrop(612 * f, 80, all, { columns: true })?.edge).toBe('after');
    }
  });
});

describe('the edges build columns, when they are allowed to', () => {
  it('resolves left and right inside the band', () => {
    expect(resolveDrop(10, 50, all, { columns: true })).toEqual({ id: 'a', edge: 'left' });
    expect(resolveDrop(602, 50, all, { columns: true })).toEqual({ id: 'a', edge: 'right' });
  });

  it('never resolves a side when columns are off', () => {
    expect(resolveDrop(10, 20, all, { columns: false })?.edge).toBe('before');
    expect(resolveDrop(602, 80, all, { columns: false })?.edge).toBe('after');
  });

  it('skips the band on a block too short to carry one', () => {
    const thin = [{ id: 'thin', rect: rect(0, 20) }];
    expect(resolveDrop(4, 4, thin, { columns: true })?.edge).toBe('before');
  });

  it('skips the band on a block too narrow to keep a middle', () => {
    const narrow = [{ id: 'narrow', rect: rect(0, 100, 0, 120) }];
    expect(resolveDrop(6, 20, narrow, { columns: true })?.edge).toBe('before');
  });
});

describe('a shaky pointer keeps its answer', () => {
  it('holds an engaged side band a little past its edge', () => {
    const engaged = { id: 'a', edge: 'right' } as const;
    const justOutside = 612 - 64 - 8; // 8px past the band
    expect(resolveDrop(justOutside, 50, all, { columns: true })?.edge).toBe('after');
    expect(resolveDrop(justOutside, 50, all, { columns: true, previous: engaged })?.edge).toBe('right');
  });

  it('holds before/after a little past the midpoint', () => {
    const engaged = { id: 'a', edge: 'before' } as const;
    expect(resolveDrop(306, 58, all, { columns: true })?.edge).toBe('after');
    expect(resolveDrop(306, 58, all, { columns: true, previous: engaged })?.edge).toBe('before');
  });

  it('never pushes the midpoint outside a short block', () => {
    // a 28px paragraph: 16px of grip either way would put the threshold beyond
    // its own edges, so approaching from below made "drop above" unreachable
    const short = [{ id: 's', rect: rect(0, 28) }];
    const fromBelow = { id: 's', edge: 'after' } as const;
    expect(resolveDrop(306, 5, short, { columns: true, previous: fromBelow })?.edge).toBe('before');
  });

  it('does not carry stickiness onto a different block', () => {
    const engaged = { id: 'a', edge: 'right' } as const;
    expect(resolveDrop(602, 200, all, { columns: true, previous: engaged })).toEqual({ id: 'b', edge: 'right' });
  });
});

describe('there are no dead zones', () => {
  it('answers in the gap between two blocks', () => {
    // y=110 is inside neither rect — the old elementsFromPoint path gave up here
    expect(resolveDrop(306, 110, all, { columns: true })).toEqual({ id: 'a', edge: 'after' });
    expect(resolveDrop(306, 118, all, { columns: true })).toEqual({ id: 'b', edge: 'before' });
  });

  it('answers past the last block', () => {
    expect(resolveDrop(306, 900, all, { columns: true })).toEqual({ id: 'b', edge: 'after' });
  });

  it('answers out in the page margin, where x is outside every block', () => {
    expect(resolveDrop(-200, 50, all, { columns: true })?.id).toBe('a');
  });

  it('returns null only when there is nothing to drop onto', () => {
    expect(resolveDrop(10, 10, [], { columns: true })).toBeNull();
  });
});

describe('nesting resolves to the innermost block', () => {
  it('prefers a child over the column that contains it', () => {
    const column: DropCandidate = { id: 'col', rect: rect(0, 200, 0, 300) };
    const child: DropCandidate = { id: 'child', rect: rect(20, 60, 10, 290) };
    expect(resolveDrop(150, 40, [column, child], { columns: true })?.id).toBe('child');
    // and outside the child, the column still answers
    expect(resolveDrop(150, 150, [column, child], { columns: true })?.id).toBe('col');
  });
});
