import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../packages/markdown/src/index';
import { plainText } from '../packages/core/src/index';
import type { BlockJSON } from '../packages/core/src/index';

/**
 * Our own documentation, run through the parser.
 *
 * @remarks
 * D7 promises markdown is two-way with a documented loss boundary. The unit
 * tests pin each rule in isolation; this checks the rules compose on a real
 * hand-wrapped document — which is where the list-item wrapping bug was
 * actually found (docs/ARCHITECTURE.md §12, reported 2026-08-07: every item
 * renumbered to 1 because its continuation lines became paragraphs between
 * the items).
 *
 * The property is **idempotence**, not equality with the source: normalising
 * source wrapping away is the deliberate loss, so `parse → print` is allowed
 * to differ from the input once, and never again after that.
 */

const DOCS = join(import.meta.dirname, '..', 'docs');
const files = readdirSync(DOCS).filter((f) => f.endsWith('.md'));

const shape = (blocks: BlockJSON[]): unknown =>
  blocks.map((b) => ({ type: b.type, text: plainText(b.text), children: shape(b.children ?? []) }));

describe('our own docs survive the markdown round trip', () => {
  it('finds documents to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} is stable after the first normalisation`, () => {
      const source = readFileSync(join(DOCS, file), 'utf8');
      const once = blocksToMarkdown(markdownToBlocks(source));
      const twice = blocksToMarkdown(markdownToBlocks(once));
      expect(twice).toBe(once);
      // and the structure, not just the bytes
      expect(shape(markdownToBlocks(twice))).toEqual(shape(markdownToBlocks(once)));
    });
  }

  it('ARCHITECTURE §12 is nine consecutive numbered items', () => {
    const blocks = markdownToBlocks(readFileSync(join(DOCS, 'ARCHITECTURE.md'), 'utf8'));
    const start = blocks.findIndex((b) => plainText(b.text).startsWith('Storage runtime/platform.'));
    expect(start).toBeGreaterThan(-1);
    // nothing may sit between them: a stray paragraph is what restarted the
    // numbering, since the DOM counts consecutive siblings
    const after = blocks.slice(start);
    const run = after.findIndex((b) => b.type !== 'numbered_list_item');
    expect(run === -1 ? after.length : run).toBe(9);
  });
});
