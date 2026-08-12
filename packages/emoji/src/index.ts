/**
 * Every emoji, named — one module per language, none of them loaded unless it
 * is imported.
 *
 * @remarks
 * The same arrangement as the editor's language packs, for the same reason and
 * with the same trade. A catalogue is ~200 kB of CLDR names; five of them is a
 * megabyte, and an application that speaks one language should carry one:
 *
 * ```ts
 * import { EMOJI_EN } from '@nbe/emoji/en'
 * new EditorView(el, editor, { emojis: EMOJI_EN })
 * ```
 *
 * A *bilingual* picker is what {@link mergeCatalogues} is for — a reader who
 * thinks in French and types « rocket » is not confused, they are bilingual,
 * and the search reads every name an entry carries:
 *
 * ```ts
 * import { EMOJI_EN } from '@nbe/emoji/en'
 * import { EMOJI_FR } from '@nbe/emoji/fr'
 * const emojis = mergeCatalogues(EMOJI_FR, EMOJI_EN)   // headings from the first
 * ```
 *
 * Importing this index for the *type* costs nothing; importing a locale from
 * it is what a bundler cannot undo. The subpaths are the entry points.
 *
 * The data is generated — `node scripts/build-emoji.mjs` — from CLDR's own
 * annotations by way of `emojibase-data`, a dev dependency. Nothing here has a
 * runtime dependency, which is the invariant that made generating it the right
 * answer rather than depending on a picker package.
 *
 * @module
 */

/**
 * An emoji and what it is called, one string per language.
 *
 * @remarks
 * Explicit tuples. Deliberately NOT a string of emojis aligned to a parallel
 * keyword array: ZWJ sequences and variation selectors make any positional
 * alignment silently drift.
 *
 * Each name string is the emoji's label followed by its keywords, comma
 * separated — « fusée, espace, vaisseau » — and the tail is open because
 * {@link mergeCatalogues} appends a language by appending a slot.
 */
export type EmojiEntry = readonly [emoji: string, ...names: string[]];

/** One CLDR group — smileys, animals, flags — under its own heading. */
export interface EmojiGroup {
  label: string;
  items: readonly EmojiEntry[];
}

/**
 * One catalogue holding every language given, searchable in all of them.
 *
 * @remarks
 * Merged by position, which is sound because every locale is generated from
 * the same source in the same order: group *n* holds emoji *i* whatever the
 * language. A mismatch would mean a regenerated file went out of step with its
 * siblings, so it throws rather than quietly pairing « fusée » with a tractor.
 *
 * Headings come from the first catalogue: it is the reader's language, and the
 * ones after it are there to be typed into, not read.
 */
export function mergeCatalogues(...catalogues: readonly (readonly EmojiGroup[])[]): readonly EmojiGroup[] {
  const [first, ...rest] = catalogues;
  if (!first) return [];
  if (!rest.length) return first;
  return first.map((group, at) => ({
    label: group.label,
    items: group.items.map((entry, i) => [
      entry[0],
      ...entry.slice(1),
      ...rest.map((other) => {
        const twin = other[at]?.items[i];
        if (!twin || twin[0] !== entry[0])
          throw new Error(`@nbe/emoji: catalogues out of step at ${at}/${i} — regenerate them together`);
        return twin.slice(1).join(', ');
      }),
    ] as unknown as EmojiEntry),
  }));
}
