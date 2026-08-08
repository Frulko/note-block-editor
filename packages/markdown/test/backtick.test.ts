import { describe, expect, it } from 'vitest';
import { markdownToRuns, runsToMarkdown } from '../src/index';

/**
 * A backtick inside inline code.
 *
 * @remarks
 * `index.ts` marks this as a known break: *"code content emitted raw; a
 * backtick inside a code run breaks — use runs without backticks in code"*.
 * A deliberate simplification with a named failure is worth confirming rather
 * than assuming, because the workaround it suggests is not one a *user* can
 * follow: they type what they type.
 *
 * CommonMark's answer is to fence with more backticks than the content
 * contains, and to pad with spaces when the content starts or ends with one.
 */
describe('inline code containing a backtick', () => {
  const trip = (text: string) => {
    const runs = [{ text, marks: [{ type: 'code' }] }];
    return markdownToRuns(runsToMarkdown(runs));
  };

  it('round-trips a backtick in the middle', () => {
    expect(trip('a ` b')).toEqual([{ text: 'a ` b', marks: [{ type: 'code' }] }]);
  });

  it('round-trips a run of several', () => {
    expect(trip('a ``` b')).toEqual([{ text: 'a ``` b', marks: [{ type: 'code' }] }]);
  });

  it('round-trips one at each edge, where the pad is needed', () => {
    // without the space the fence would close immediately on the content
    expect(trip('`x`')).toEqual([{ text: '`x`', marks: [{ type: 'code' }] }]);
  });

  it('leaves ordinary code alone, with a single fence and no padding', () => {
    expect(runsToMarkdown([{ text: 'const x = 1', marks: [{ type: 'code' }] }])).toBe('`const x = 1`');
  });

  it('does not eat a space a user actually wrote', () => {
    // the pad is stripped only when symmetric *and* the content is longer than
    // the two spaces, so ' ' stays ' '
    expect(trip(' x ')).toEqual([{ text: ' x ', marks: [{ type: 'code' }] }]);
  });
});
