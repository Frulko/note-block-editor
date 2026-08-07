import { describe, expect, it } from 'vitest';
import { plainText, type BlockJSON } from '@nbe/core';
import { enhancedToBlocks, isEnhancedMarkdown } from '../src/enhanced';

/**
 * Notion's "Enhanced Markdown": Markdown plus XML-ish containers for exactly
 * the constructs Markdown cannot express.
 *
 * The tag inventory comes from `docs/research/storage-markdown-sqlite.md` §2d.
 * As with the ZIP importer, these fixtures are written from that description
 * and not captured from a real workspace.
 */

const types = (blocks: BlockJSON[]) => blocks.map((b) => b.type);

describe('detecting the flavour', () => {
  it('recognises a document that uses the tags', () => {
    expect(isEnhancedMarkdown('<callout>\nCoucou\n</callout>')).toBe(true);
    expect(isEnhancedMarkdown('<details>\n<summary>X</summary>\n</details>')).toBe(true);
  });

  it('leaves plain markdown alone', () => {
    expect(isEnhancedMarkdown('# Titre\n\nDu texte, et <em>même</em> du HTML.')).toBe(false);
  });
});

describe('containers become blocks', () => {
  it('a callout keeps its icon and its text', () => {
    const [callout] = enhancedToBlocks('<callout icon="⚠️">\nAttention à ceci\n</callout>');
    expect(callout!.type).toBe('callout');
    expect(callout!.props!['icon']).toBe('⚠️');
    expect(plainText(callout!.text)).toBe('Attention à ceci');
  });

  it('a callout with more than one paragraph nests the rest', () => {
    const [callout] = enhancedToBlocks('<callout>\nPremière ligne\n\nSeconde\n</callout>');
    expect(plainText(callout!.text)).toBe('Première ligne');
    expect(plainText(callout!.children![0]!.text)).toBe('Seconde');
  });

  it('details becomes a toggle, with the summary as its text', () => {
    const [toggle] = enhancedToBlocks('<details>\n<summary>Voir plus</summary>\n\nCaché ici.\n</details>');
    expect(toggle!.type).toBe('toggle');
    expect(plainText(toggle!.text)).toBe('Voir plus');
    expect(plainText(toggle!.children![0]!.text)).toBe('Caché ici.');
  });

  it('columns become a column list holding columns', () => {
    const [list] = enhancedToBlocks(
      '<columns>\n<column>\nGauche\n</column>\n<column>\nDroite\n</column>\n</columns>',
    );
    expect(list!.type).toBe('column_list');
    expect(types(list!.children!)).toEqual(['column', 'column']);
    expect(plainText(list!.children![0]!.children![0]!.text)).toBe('Gauche');
  });

  it('nests containers inside containers', () => {
    const [list] = enhancedToBlocks(
      '<columns>\n<column>\n<callout>\nDans une colonne\n</callout>\n</column>\n</columns>',
    );
    const callout = list!.children![0]!.children![0]!;
    expect(callout.type).toBe('callout');
    expect(plainText(callout.text)).toBe('Dans une colonne');
  });

  it('keeps the markdown around the containers', () => {
    const blocks = enhancedToBlocks('# Titre\n\n<callout>\nEncadré\n</callout>\n\nAprès.');
    expect(types(blocks)).toEqual(['heading', 'callout', 'paragraph']);
  });
});

describe('references and inline tags', () => {
  it('a page reference becomes a link block carrying its title', () => {
    const [ref] = enhancedToBlocks('<page url="https://notion.so/abc">\nMa page\n</page>');
    expect(ref!.type).toBe('link_to_page');
    expect(ref!.props!['title']).toBe('Ma page');
  });

  it('an inline page mention becomes a link the ZIP importer can resolve', () => {
    const [para] = enhancedToBlocks('Voir <mention-page url="Autre%20page.md">Autre page</mention-page> pour la suite.');
    const marks = (para!.text ?? []).flatMap((r) => r.marks ?? []);
    expect(marks.map((m) => m.type)).toEqual(['link']);
    expect(marks[0]!.attrs!['href']).toBe('Autre%20page.md');
  });

  it('a date mention keeps the date', () => {
    const [para] = enhancedToBlocks('Rendu le <mention-date start="2026-08-07" timeZone="Europe/Paris"/>.');
    expect(plainText(para!.text)).toBe('Rendu le 2026-08-07.');
  });

  it('drops a colour attribute and keeps the words', () => {
    const [para] = enhancedToBlocks('Du texte important{color="Blue"} ici.');
    expect(plainText(para!.text)).toBe('Du texte important ici.');
  });

  it('an unknown attribute is left visible rather than silently eaten', () => {
    const [para] = enhancedToBlocks('Texte{color="Chartreuse"} ici.');
    expect(plainText(para!.text)).toContain('Chartreuse');
  });
});

describe('what cannot be mapped loses its wrapper, never its content', () => {
  it('a synced block unwraps to the blocks it held', () => {
    const blocks = enhancedToBlocks('<synced_block>\nContenu partagé\n</synced_block>');
    expect(types(blocks)).toEqual(['paragraph']);
    expect(plainText(blocks[0]!.text)).toBe('Contenu partagé');
  });

  it('a table of contents disappears, since it is derived and not authored', () => {
    const blocks = enhancedToBlocks('<table_of_contents/>\n\nDu texte.');
    expect(types(blocks)).toEqual(['paragraph']);
  });

  it('an unbalanced tag imports the rest of the document rather than failing', () => {
    const blocks = enhancedToBlocks('<callout>\nJamais fermé\n\nEt du texte après.');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => plainText(b.text)).join(' ')).toContain('Et du texte après.');
  });
});
