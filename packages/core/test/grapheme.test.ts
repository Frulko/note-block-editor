import { describe, expect, it } from 'vitest';
import {
  GRAPHEME_AWARE,
  graphemeBoundaries,
  graphemeLength,
  nextGrapheme,
  nextWord,
  prevGrapheme,
  prevWord,
  snapGrapheme,
} from '../src/grapheme';

/**
 * AQ#4. Offsets are UTF-16 code units because that is what the DOM speaks, but
 * a user edits perceived characters — and several things that look like one
 * character are not one code unit, or even one code point.
 */

const FAMILY = '👨‍👩‍👧'; // three people joined by zero-width joiners
const FLAG = '🇫🇷'; // two regional indicators
const ACCENT = 'é'; // e + combining acute, which renders as é
const DEVANAGARI = 'क्षि';

describe('the engine can segment', () => {
  it('has Intl.Segmenter, so these tests mean what they say', () => {
    // if this ever fails the suite below is testing the fallback instead
    expect(GRAPHEME_AWARE).toBe(true);
  });
});

describe('counting what a reader would count', () => {
  it('a family emoji is one character, not eight code units', () => {
    expect(FAMILY.length).toBe(8);
    expect(graphemeLength(FAMILY)).toBe(1);
  });

  it('a flag is one character', () => {
    expect(graphemeLength(FLAG)).toBe(1);
  });

  it('a decomposed accent is one character', () => {
    expect(ACCENT.length).toBe(2);
    expect(graphemeLength(ACCENT)).toBe(1);
  });

  it('an Indic cluster is one character', () => {
    expect(graphemeLength(DEVANAGARI)).toBe(1);
  });

  it('plain text is itself', () => {
    expect(graphemeLength('bonjour')).toBe(7);
    expect(graphemeLength('')).toBe(0);
  });
});

describe('stepping backward deletes one character', () => {
  it('takes the whole family in one step', () => {
    expect(prevGrapheme(`a${FAMILY}`, 1 + FAMILY.length)).toBe(1);
  });

  it('takes the whole flag', () => {
    expect(prevGrapheme(FLAG, FLAG.length)).toBe(0);
  });

  it('takes the accent with its letter', () => {
    expect(prevGrapheme(`caf${ACCENT}`, 3 + ACCENT.length)).toBe(3);
  });

  it('takes one letter at a time in plain text', () => {
    expect(prevGrapheme('abc', 3)).toBe(2);
  });

  it('stops at the start rather than going negative', () => {
    expect(prevGrapheme('abc', 0)).toBe(0);
    expect(prevGrapheme('', 0)).toBe(0);
  });
});

describe('stepping forward deletes one character', () => {
  it('takes the whole family', () => {
    expect(nextGrapheme(`${FAMILY}a`, 0)).toBe(FAMILY.length);
  });

  it('takes one letter at a time in plain text', () => {
    expect(nextGrapheme('abc', 0)).toBe(1);
  });

  it('stops at the end', () => {
    expect(nextGrapheme('abc', 3)).toBe(3);
  });
});

describe('an offset that landed mid-character is moved off it', () => {
  const text = `a${FAMILY}b`;
  const inside = 3; // inside the family's first surrogate pair

  it('rounds back for the start of a range, so nothing is lost', () => {
    expect(snapGrapheme(text, inside, 'back')).toBe(1);
  });

  it('rounds forward for the end of a range, so nothing is lost', () => {
    expect(snapGrapheme(text, inside, 'forward')).toBe(1 + FAMILY.length);
  });

  it('leaves an offset that is already on a boundary alone', () => {
    expect(snapGrapheme(text, 1)).toBe(1);
    expect(snapGrapheme(text, 1 + FAMILY.length)).toBe(1 + FAMILY.length);
  });

  it('clamps an offset outside the text', () => {
    expect(snapGrapheme(text, -5)).toBe(0);
    expect(snapGrapheme(text, 999)).toBe(text.length);
  });
});

describe('long text is handled by a window, and gives the same answer', () => {
  const long = 'x'.repeat(500) + FAMILY + 'y'.repeat(500);

  it('finds the boundary far from the start of the string', () => {
    expect(prevGrapheme(long, 500 + FAMILY.length)).toBe(500);
  });

  it('the window never starts inside a surrogate pair', () => {
    // an offset exactly one window past a pair would otherwise slice it
    const text = 'a'.repeat(120) + FAMILY + 'b'.repeat(200);
    expect(prevGrapheme(text, 120 + FAMILY.length)).toBe(120);
  });

  it('agrees with segmenting the whole string', () => {
    const all = graphemeBoundaries(long);
    for (const boundary of [1, 250, 500, 500 + FAMILY.length, 800]) {
      const expected = all[all.indexOf(boundary) - 1];
      if (expected !== undefined) expect(prevGrapheme(long, boundary)).toBe(expected);
    }
  });
});

/**
 * The same table at word granularity, for ⌥⌫ and ^K. The reason not to scan
 * for spaces is the last case here: half the world does not write them.
 */
describe('word boundaries', () => {
  it('takes the word before the caret, with the space that follows it', () => {
    expect(prevWord('bonjour tout le monde', 21)).toBe(16);
    expect(prevWord('bonjour tout le ', 16)).toBe(13);
  });

  it('takes the word after the caret', () => {
    expect(nextWord('bonjour tout le monde', 8)).toBe(12);
    expect(nextWord('bonjour tout le monde', 0)).toBe(7);
  });

  it('stops at the ends rather than running off them', () => {
    expect(prevWord('mot', 0)).toBe(0);
    expect(nextWord('mot', 3)).toBe(3);
    expect(prevWord('', 0)).toBe(0);
  });

  it('eats a run of spaces rather than stalling on one', () => {
    expect(prevWord('mot   ', 6)).toBe(0);
    expect(nextWord('   mot', 0)).toBe(6);
  });

  it('finds words in a script that writes none of the spaces', () => {
    // 私 / は / 学生 — a whitespace scan would take the whole sentence
    expect(prevWord('私は学生です', 4)).toBe(2);
  });
});
