import { describe, expect, it } from 'vitest';
import { titleFromHtml } from '../apps/obsidian/src/link-title';

/**
 * Reading a page's title out of its markup, so a long URL in a sentence can be
 * called what the page calls itself.
 *
 * The fetch belongs to the vault — `requestUrl` goes through Electron's main
 * process and is not subject to CORS, which a browser is and cannot escape.
 * What is worth testing here is the parsing, which is where a title turns into
 * something legible or into a line of whitespace.
 */
describe('the title of a page', () => {
  it('comes from <title>', () => {
    expect(titleFromHtml('<html><head><title>Le titre</title></head>')).toBe('Le titre');
  });

  it('prefers og:title, which is the one the site chose for being quoted', () => {
    const html = '<meta property="og:title" content="Pour partage"><title>Pour l’onglet</title>';
    expect(titleFromHtml(html)).toBe('Pour partage');
  });

  it('is one line: a pretty-printed tag collapses', () => {
    expect(titleFromHtml('<title>\n   Un titre\n   sur deux lignes\n</title>')).toBe('Un titre sur deux lignes');
  });

  it('decodes the entities a title actually contains', () => {
    expect(titleFromHtml('<title>Caf&eacute; &amp; th&#233; &#x2014; la carte</title>')).toBe(
      'Caf&eacute; & thé — la carte',
    );
  });

  it('is capped, because a link label is not an article', () => {
    const long = 'a'.repeat(400);
    const title = titleFromHtml(`<title>${long}</title>`)!;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });

  it('is null when there is nothing to read', () => {
    expect(titleFromHtml('<html><body>rien</body></html>')).toBeNull();
    expect(titleFromHtml('<title>   </title>')).toBeNull();
  });
});
