import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';

/**
 * Opening a note and closing it must leave no diff.
 *
 * @remarks
 * The Obsidian plugin's whole bargain is that the file stays yours: it parses a
 * note on open and writes the projection back on save. If that round trip is
 * not stable, merely *looking* at a note through Carnet rewrites it, and the
 * user finds a dirty vault they did not touch. That is worse than a missing
 * feature, so the claim in the plugin's README is tested rather than asserted.
 *
 * Constructs owned by a block plugin are round-tripped in that plugin's own
 * tests, with it registered — a table here would only prove that this package
 * still hardcodes one (`packages/blocks-table/test/markdown.test.ts`).
 */

const NOTES: Array<[string, string]> = [
  ['a heading and a paragraph', '# Titre\n\nUn paragraphe avec du **gras** et de l’*italique*.'],
  ['a bulleted list, nested', '- un\n- deux\n    - imbriqué'],
  ['a numbered list', '1. premier\n2. second'],
  ['a quote', '> une citation'],
  ['to-dos, both states', '- [ ] à faire\n- [x] fait'],
  ['a wikilink beside a link', 'Un [[wikilink]] et un [lien](https://exemple.fr).'],
  ['a divider', '---'],
  ['headings of three levels', '# Un\n\n## Deux\n\n### Trois'],
  ['a file card', '[contrat.pdf](../assets/abc.pdf) <!-- nbe:file {"props":{"mime":"application/pdf","size":9}} -->'],
  ['an image with a caption', '![alt](../assets/x.png) <!-- nbe:image {"props":{"caption":"Le schéma"}} -->'],
  /*
   * Obsidian's own spelling for an attachment, and the syntax it writes by
   * default — so a vault is full of it. Rewriting each one as `![](x.png)` on
   * the first save would leave a diff on every image in every note that was
   * merely opened, which is the one thing this file exists to prevent.
   */
  ['an Obsidian embed', '![[Pasted image 20260809.png]]'],
  ['an embed with an alias', '![[schema.png|Le schéma]]'],
];

describe('a note survives being opened', () => {
  for (const [what, markdown] of NOTES) {
    it(`${what} comes back unchanged`, () => {
      expect(blocksToMarkdown(markdownToBlocks(markdown)).trim()).toBe(markdown.trim());
    });
  }

  it('is idempotent, so a second open changes nothing either', () => {
    for (const [, markdown] of NOTES) {
      const once = blocksToMarkdown(markdownToBlocks(markdown));
      expect(blocksToMarkdown(markdownToBlocks(once))).toBe(once);
    }
  });
});
