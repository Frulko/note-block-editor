import { describe, expect, it } from 'vitest';
import {
  applyMark,
  hasMark,
  marksAt,
  normalizeRuns,
  plainText,
  sliceRuns,
  spliceRuns,
  textLength,
} from '../src/richtext';
import type { Run } from '../src/types';

const bold = { type: 'bold' };

describe('richtext', () => {
  it('normalizes adjacent runs with equal marks and drops empties', () => {
    const runs: Run[] = [
      { text: 'a' },
      { text: '' },
      { text: 'b' },
      { text: 'c', marks: [bold] },
      { text: 'd', marks: [{ type: 'bold' }] },
    ];
    expect(normalizeRuns(runs)).toEqual([
      { text: 'ab', marks: undefined },
      { text: 'cd', marks: [bold] },
    ]);
  });

  it('slices across run boundaries preserving marks', () => {
    const runs: Run[] = [{ text: 'hello ' }, { text: 'world', marks: [bold] }];
    expect(plainText(sliceRuns(runs, 3, 8))).toBe('lo wo');
    expect(sliceRuns(runs, 6, 11)).toEqual([{ text: 'world', marks: [bold] }]);
  });

  it('splices text in and out', () => {
    const runs: Run[] = [{ text: 'hello world' }];
    const out = spliceRuns(runs, 5, 5, [{ text: ',' }]);
    expect(plainText(out)).toBe('hello, world');
    expect(plainText(spliceRuns(out, 0, 6, []))).toBe(' world');
  });

  it('applies and removes marks over a range', () => {
    const runs: Run[] = [{ text: 'hello world' }];
    const marked = applyMark(runs, 0, 5, bold, true);
    expect(marked).toEqual([{ text: 'hello', marks: [bold] }, { text: ' world', marks: undefined }]);
    expect(hasMark(marked, 0, 5, 'bold')).toBe(true);
    expect(hasMark(marked, 0, 6, 'bold')).toBe(false);
    const unmarked = applyMark(marked, 0, 5, bold, false);
    expect(unmarked).toEqual([{ text: 'hello world', marks: undefined }]);
  });

  it('reports marks at the caret from the previous character', () => {
    const runs: Run[] = [{ text: 'ab', marks: [bold] }, { text: 'cd' }];
    expect(marksAt(runs, 0)).toBeUndefined();
    expect(marksAt(runs, 2)).toEqual([bold]);
    expect(marksAt(runs, 3)).toBeUndefined();
  });

  it('computes length', () => {
    expect(textLength([{ text: 'ab' }, { text: 'cd' }])).toBe(4);
    expect(textLength(undefined)).toBe(0);
  });
});
