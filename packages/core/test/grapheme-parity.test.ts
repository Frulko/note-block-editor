import { describe, expect, it } from 'vitest';
import { nextGrapheme, prevGrapheme, snapGrapheme } from '../src/grapheme';

/**
 * The same answers Swift gives.
 *
 * @remarks
 * `native/swift/Tests/NbeModelTests/OffsetTests.swift` asserts these exact
 * numbers on these exact strings. Two people editing one document must agree
 * about where a caret is; if one of them snaps a position inside an emoji
 * forward and the other snaps it back, they disagree about what was selected
 * and one of them deletes the wrong thing.
 *
 * Kept as literal expectations in both languages rather than a shared fixture,
 * because the point is that two implementations independently produce the same
 * number — a fixture one of them generated would only prove it can read a file.
 */

const WAVE = '🌊'; // one cluster, two UTF-16 units
const FAMILY = '👨‍👩‍👧'; // one cluster, eight units, joined by ZWJs

describe('Swift and TypeScript count the same way', () => {
  it('a surrogate pair is two units and one cluster', () => {
    const text = `a${WAVE}b`;
    expect(text.length).toBe(4);
    expect([...text].length).toBe(3);
    expect(nextGrapheme(text, 1)).toBe(3);
  });

  it('an offset inside a cluster rounds the way it is asked', () => {
    const text = `a${WAVE}b`;
    // back for the start of a range, forward for its end, so a snap only grows
    expect(snapGrapheme(text, 2, 'back')).toBe(1);
    expect(snapGrapheme(text, 2, 'forward')).toBe(3);
  });

  it('a zero-width-joiner sequence is never split', () => {
    const text = `x${FAMILY}y`;
    const end = 1 + FAMILY.length;
    for (let offset = 2; offset < end; offset++) {
      expect(snapGrapheme(text, offset, 'back'), `offset ${offset} split it going back`).toBe(1);
      expect(snapGrapheme(text, offset, 'forward'), `offset ${offset} split it going forward`).toBe(end);
    }
  });

  it('moving backwards crosses a whole cluster', () => {
    const text = `x${FAMILY}y`;
    expect(prevGrapheme(text, text.length)).toBe(text.length - 1);
    expect(prevGrapheme(text, text.length - 1)).toBe(1);
  });

  it('clamps at both ends rather than throwing', () => {
    expect(snapGrapheme('abc', -5)).toBe(0);
    expect(snapGrapheme('abc', 99)).toBe(3);
    expect(prevGrapheme('abc', 0)).toBe(0);
    expect(nextGrapheme('abc', 3)).toBe(3);
  });

  it('an accented letter is one cluster, as the fixture assumes', () => {
    expect(nextGrapheme('écrit par TypeScript', 0)).toBe(1);
  });
});
