import { mergeCatalogues, type EmojiGroup } from '@nbe/emoji';
import { EMOJI_EN } from '@nbe/emoji/en';
import { EMOJI_FR } from '@nbe/emoji/fr';
import { EMOJI_ES } from '@nbe/emoji/es';
import { EMOJI_IT } from '@nbe/emoji/it';
import { EMOJI_DE } from '@nbe/emoji/de';

/**
 * The emoji the icon picker offers, in the vault's language.
 *
 * @remarks
 * All five catalogues are imported here, and that is the same trade the
 * language packs document: the choice is a *setting*, so it is not known at
 * build time, so every language has to be in the bundle. ~110 kB each. An
 * application picks; a library would take one and let its host name it, which
 * is exactly what `@nbe/emoji`'s subpaths are for.
 *
 * English sits behind whatever language is chosen, never replaced by it. That
 * is not a fallback for missing names — CLDR translates all 1914 — it is the
 * search: half the words anyone reaches for on a keyboard are English, and a
 * French reader typing « rocket » is not making a mistake to be corrected.
 *
 * @module
 */

const CATALOGUES: Record<string, readonly EmojiGroup[]> = {
  en: EMOJI_EN,
  fr: EMOJI_FR,
  es: EMOJI_ES,
  it: EMOJI_IT,
  de: EMOJI_DE,
};

/** Merging pairs 1914 entries; a language is asked for on every note opened. */
const merged = new Map<string, readonly EmojiGroup[]>();

/** The catalogue for a locale — its own names, plus English to search in. */
export function emojisFor(locale: string): readonly EmojiGroup[] {
  const known = merged.get(locale);
  if (known) return known;
  const own = CATALOGUES[locale] ?? EMOJI_EN;
  const catalogue = own === EMOJI_EN ? EMOJI_EN : mergeCatalogues(own, EMOJI_EN);
  merged.set(locale, catalogue);
  return catalogue;
}
