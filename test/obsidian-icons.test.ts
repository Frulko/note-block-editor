import { describe, expect, it } from 'vitest';
import { isImageSrc } from '../apps/obsidian/src/icons';

/**
 * The one branch in the icon code: an icon is either drawn as text or loaded
 * as a picture, and getting it wrong shows an emoji as a broken image — or a
 * filename, spelled out, beside a note in the explorer.
 */
describe('a note icon', () => {
  it('is text when it is an emoji', () => {
    for (const emoji of ['🚀', '❝', '⚠️', '🧑‍💻']) expect(isImageSrc(emoji)).toBe(false);
  });

  it('is a picture when it names one, in the vault or on the web', () => {
    expect(isImageSrc('https://exemple.fr/photo.jpg')).toBe(true);
    expect(isImageSrc('Pièces jointes/Photo de couverture.png')).toBe(true);
    expect(isImageSrc('data:image/png;base64,AAAA')).toBe(true);
    expect(isImageSrc('app://local/x.webp')).toBe(true);
    // the extension decides, whatever the case it is written in
    expect(isImageSrc('logo.SVG')).toBe(true);
  });

  it('is not a picture when the file is something else', () => {
    expect(isImageSrc('Réunion.md')).toBe(false);
    expect(isImageSrc('Rapport.pdf')).toBe(false);
  });
});
