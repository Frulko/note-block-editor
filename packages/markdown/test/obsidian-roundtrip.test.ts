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
 */

const NOTES: Array<[string, string]> = [
  ['a heading and a paragraph', '# Titre\n\nUn paragraphe avec du **gras** et de l’*italique*.'],
  ['a bulleted list, nested', '- un\n- deux\n    - imbriqué'],
  ['a numbered list', '1. premier\n2. second'],
  ['a quote', '> une citation'],
  ['to-dos, both states', '- [ ] à faire\n- [x] fait'],
  ['a fenced code block', '```js\nconst x = 1;\n```'],
  ['a table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['a wikilink beside a link', 'Un [[wikilink]] et un [lien](https://exemple.fr).'],
  ['a divider', '---'],
  ['headings of three levels', '# Un\n\n## Deux\n\n### Trois'],
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
