// The parser used to make one block per line, so a hand-wrapped paragraph came
// back as a pile of paragraphs and the round trip was unstable — which
// contradicts D7's two-way promise. These pin the corrected contract.
import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';
import { plainText, type Run } from '@nbe/core';

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
    ['lone image', '![alt](a.png)'],
    ['lone wikilink', '[[Une page]]'],
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

// Wrapping applies to every block that carries inline text, not just to
// paragraphs. It did not, and the visible damage went further than the text:
// each stray continuation paragraph landed *between* two list items, so the
// DOM's `listNumber` — which counts consecutive siblings — restarted at 1 on
// every item. Reported from docs/ARCHITECTURE.md §12.
describe('a list item spans consecutive lines too', () => {
  const wrapped = [
    '1. **Storage runtime.** Browser (OPFS/File System Access) vs',
    '   Tauri/Electron vs CLI; atomic temp+rename writes, debounced saves.',
    '2. **Binary assets.** Where blobs live across L0/L1/L2,',
    '   content-hash dedup, reference counting.',
    '3. **Unicode.** Short one.',
  ].join('\n');

  it('folds the continuation into the item, leaving nothing between items', () => {
    const blocks = parse(wrapped);
    expect(blocks.map((b) => b.type)).toEqual([
      'numbered_list_item',
      'numbered_list_item',
      'numbered_list_item',
    ]);
  });

  it('joins with a space and drops the source indentation', () => {
    expect(plainText(parse(wrapped)[0]!.text)).toBe(
      'Storage runtime. Browser (OPFS/File System Access) vs Tauri/Electron vs CLI; atomic temp+rename writes, debounced saves.',
    );
  });

  it('accepts a lazy continuation, unindented, as CommonMark does', () => {
    expect(text('1. item\nlazy tail\n2. next')).toEqual(['item lazy tail', 'next']);
  });

  it('still ends the item when the next line starts a construct', () => {
    expect(parse('- item\n# heading').map((b) => b.type)).toEqual(['bulleted_list_item', 'heading']);
  });

  it('keeps a hard break inside the item', () => {
    expect(text('- line one  \n  line two')).toEqual(['line one\nline two']);
  });

  it('still nests a deeper item as a child, not as continuation', () => {
    const blocks = parse('- item one\n  continues\n    - nested\n- item two');
    expect(blocks).toHaveLength(2);
    expect(plainText(blocks[0]!.text)).toBe('item one continues');
    expect(blocks[0]!.children!.map((c) => plainText(c.text))).toEqual(['nested']);
  });

  it('applies to to-dos and bullets, not only numbered items', () => {
    expect(text('- [ ] a task that\n  wraps\n- [x] done')).toEqual(['a task that wraps', 'done']);
    expect(text('- a bullet that\n  wraps')).toEqual(['a bullet that wraps']);
  });
});

describe('the markdown file stays readable', () => {
  it('numbers consecutive items 1, 2, 3 rather than 1, 1, 1', () => {
    // it round-trips either way — CommonMark renumbers — but "readable without
    // the tool" is the point of the projection, and 1., 1., 1. is not
    const out = blocksToMarkdown(parse('1. one\n2. two\n3. three'));
    expect(out.split('\n')).toEqual(['1. one', '2. two', '3. three']);
  });

  it('restarts numbering after a break in the run', () => {
    const out = blocksToMarkdown(parse('1. one\n2. two\n\npara\n\n1. fresh'));
    expect(out.split('\n').filter((l) => /^\d/.test(l))).toEqual(['1. one', '2. two', '1. fresh']);
  });

  it('numbers nested runs independently of their parent', () => {
    const out = blocksToMarkdown(parse('1. one\n    1. a\n    2. b\n2. two'));
    expect(out.split('\n').map((l) => l.trim())).toEqual(['1. one', '1. a', '2. b', '2. two']);
  });
});

// A mark that spans a formatting change used to close at the inner mark's
// boundary and immediately reopen — `~~a *b*~~` came out `~~a ~~~~*b*~~`,
// which then re-parsed as literal tildes. Found by the round-trip test on
// docs/ROADMAP.md, 2026-08-07.
describe('a mark spans the runs that share it', () => {
  const md = (runs: Run[]) => blocksToMarkdown([{ id: 'x', type: 'paragraph', version: 1, text: runs }]);

  it('does not close and reopen around an inner mark', () => {
    expect(
      md([
        { text: 'Notion ', marks: [{ type: 'strike' }] },
        { text: 'Enhanced', marks: [{ type: 'strike' }, { type: 'italic' }] },
      ]),
    ).toBe('~~Notion *Enhanced*~~');
  });

  it('round-trips that text unchanged', () => {
    const source = '~~Notion *Enhanced Markdown*~~ — expédié';
    const once = blocksToMarkdown(parse(source));
    expect(blocksToMarkdown(parse(once))).toBe(once);
    expect(once).not.toContain('~~~~');
  });

  it('closes a mark where it genuinely ends', () => {
    expect(
      md([
        { text: 'gras', marks: [{ type: 'bold' }] },
        { text: ' normal' },
      ]),
    ).toBe('**gras** normal');
  });

  it('keeps two separate marks separate, rather than merging them', () => {
    expect(
      md([
        { text: 'un', marks: [{ type: 'bold' }] },
        { text: ' et ' },
        { text: 'deux', marks: [{ type: 'bold' }] },
      ]),
    ).toBe('**un** et **deux**');
  });

  it('does not merge links that point at different places', () => {
    const out = md([
      { text: 'a', marks: [{ type: 'link', attrs: { href: 'x' } }] },
      { text: 'b', marks: [{ type: 'link', attrs: { href: 'y' } }] },
    ]);
    expect(out).toBe('[a](x)[b](y)');
  });

  it('nests three marks without duplicating any of them', () => {
    const out = md([
      { text: 'a ', marks: [{ type: 'bold' }] },
      { text: 'b ', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { text: 'c', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }] },
    ]);
    expect(out).toBe('**a *b ~~c~~***');
    expect(blocksToMarkdown(parse(out))).toBe(out);
  });
});
