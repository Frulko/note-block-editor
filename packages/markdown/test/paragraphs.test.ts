// The parser used to make one block per line, so a hand-wrapped paragraph came
// back as a pile of paragraphs and the round trip was unstable — which
// contradicts D7's two-way promise. These pin the corrected contract.
import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';
import { plainText } from '@nbe/core';

const parse = (md: string) => markdownToBlocks(md);
const text = (md: string) => parse(md).map((b) => plainText(b.text));

describe('a paragraph spans consecutive lines', () => {
  it('joins wrapped lines into one block', () => {
    expect(parse('Première ligne\nseconde ligne.')).toHaveLength(1);
  });

  it('joins them with a space, because a soft break is not content', () => {
    // CommonMark: a bare newline inside a paragraph renders as a space. How a
    // file happens to be wrapped is presentation of the source, not of the
    // document — this is the documented, deliberate loss.
    expect(text('Une phrase\nqui continue.')).toEqual(['Une phrase qui continue.']);
  });

  it('keeps a blank line as a paragraph boundary', () => {
    expect(text('Un.\n\nDeux.')).toEqual(['Un.', 'Deux.']);
  });

  it('treats several blank lines as one boundary', () => {
    expect(parse('Un.\n\n\n\nDeux.')).toHaveLength(2);
  });
});

describe('hard breaks survive, because they are content', () => {
  it('reads a trailing backslash as a line break', () => {
    expect(text('Une ligne\\\nune autre')).toEqual(['Une ligne\nune autre']);
  });

  it('reads two trailing spaces as a line break', () => {
    expect(text('Une ligne  \nune autre')).toEqual(['Une ligne\nune autre']);
  });

  it('mixes hard and soft breaks in one paragraph', () => {
    expect(text('a\\\nb\nc')).toEqual(['a\nb c']);
  });
});

describe('a construct always ends the paragraph', () => {
  // the guard against drift: adding a construct to parseLevel without adding
  // it to CONSTRUCT_STARTS makes exactly one of these fail
  it.each([
    ['heading', '# Titre'],
    ['bulleted item', '- un'],
    ['numbered item', '1. un'],
    ['to-do', '- [ ] un'],
    ['quote', '> cité'],
    ['callout', '> [!info] note'],
    ['divider', '---'],
    ['fenced code', '```ts'],
    ['lone image', '![alt](a.png)'],
    ['lone wikilink', '[[Une page]]'],
    ['table', 'a | b\n--- | ---\n1 | 2'],
  ])('%s on the next line starts a new block', (_name, construct) => {
    const blocks = parse(`Du texte\n${construct}`);
    expect(blocks.length).toBeGreaterThan(1);
    expect(plainText(blocks[0]!.text)).toBe('Du texte');
  });
});

describe('round-trip stability', () => {
  it('is idempotent from the second pass, which is the contract that matters', () => {
    // the first serialize may re-wrap a hand-wrapped source; every pass after
    // it must be byte-identical, or diffs churn forever
    const once = blocksToMarkdown(parse('Une phrase\nqui continue.'));
    const twice = blocksToMarkdown(parse(once));
    expect(twice).toBe(once);
  });

  it('is byte-stable for a document it produced', () => {
    const source = '# Titre\n\nUn paragraphe.\n\n- un\n- deux';
    const once = blocksToMarkdown(parse(source));
    expect(blocksToMarkdown(parse(once))).toBe(once);
  });

  it('preserves a hard break across a full round trip', () => {
    const blocks = parse('a\\\nb');
    const out = blocksToMarkdown(blocks);
    expect(text(out)).toEqual(['a\nb']);
  });
});
