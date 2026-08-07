import { describe, expect, it } from 'vitest';
import { MARKS, expandsForward, markExpansion, registerMark } from '../src/marks';
import { marksAt } from '../src/richtext';
import type { Run } from '../src/types';

/**
 * Peritext expansion, which §2.2 said had been declared and had not.
 *
 * Found while auditing Loro for phase 5: its `configTextStyle` takes exactly
 * this per-mark configuration, and there was nothing to give it. The metadata
 * turned out not to be dormant either — it decides what the *next typed
 * character* inherits, which was wrong for links and code.
 */

const runs = (...parts: Array<[text: string, ...marks: string[]]>): Run[] =>
  parts.map(([text, ...marks]) => ({ text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) }));

describe('what a mark does at its edge', () => {
  it('emphasis continues when you keep typing', () => {
    for (const type of ['bold', 'italic', 'underline', 'strike']) {
      expect(expandsForward(type)).toBe(true);
    }
  });

  it('a link does not, because text after it is not part of its target', () => {
    expect(markExpansion('link')).toBe('none');
    expect(expandsForward('link')).toBe(false);
  });

  it('code and mentions do not either', () => {
    expect(expandsForward('code')).toBe(false);
    expect(expandsForward('mention')).toBe(false);
  });

  it('an unregistered mark is treated as emphasis', () => {
    // the less surprising failure: continuing formatting you just applied
    expect(expandsForward('highlight-from-a-plugin')).toBe(true);
  });

  it('a plugin can say otherwise', () => {
    registerMark({ type: 'comment-anchor', expand: 'none' });
    expect(expandsForward('comment-anchor')).toBe(false);
  });

  it('covers the closed mark set of §2.2', () => {
    const declared = new Set(MARKS.map((spec) => spec.type));
    for (const type of ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'color', 'background', 'mention']) {
      expect(declared.has(type)).toBe(true);
    }
  });
});

describe('what the next typed character inherits', () => {
  it('carries emphasis forward', () => {
    expect(marksAt(runs(['gras', 'bold']), 4)).toEqual([{ type: 'bold' }]);
  });

  it('does not extend a link', () => {
    // typing after a link used to make the next word clickable
    expect(marksAt(runs(['site', 'link']), 4)).toBeUndefined();
  });

  it('does not stay inside code', () => {
    expect(marksAt(runs(['const', 'code']), 5)).toBeUndefined();
  });

  it('keeps the emphasis of a run that is also a link', () => {
    const at = marksAt(runs(['gras et lié', 'bold', 'link']), 11);
    expect(at).toEqual([{ type: 'bold' }]);
  });

  it('carries nothing at the start of a block', () => {
    expect(marksAt(runs(['texte', 'bold']), 0)).toBeUndefined();
  });
});
