/**
 * Generate `packages/emoji/src/<locale>.ts` — every emoji, named, one module
 * per language the editor speaks.
 *
 * @remarks
 * The same arrangement as `build-icons.mjs`, and for the same reason: an
 * empty runtime dependency list is a CI-enforced invariant across this repo,
 * so the data is *generated* into checked-in modules rather than imported from
 * a package at runtime. `emojibase-data` is a dev dependency; it is CLDR's own
 * annotations, which is where every language here comes from — writing 1900
 * names by hand is not a thing anyone should do once, let alone five times.
 *
 * One file per locale, never one file holding five: the whole point is that a
 * bundler drops the four an application does not name, exactly as it drops the
 * unused language packs in `@nbe/dom/src/i18n`.
 *
 * What is dropped, and why:
 * - skin-tone and hair variants (`skins`): five copies of every person is a
 *   picker nobody can scan. A tone selector is the upgrade, not more rows.
 * - the `component` group: skin tones and hair colours are modifiers, not
 *   emoji anyone means to insert on their own.
 * - tags beyond the fourth: the tail of CLDR's keyword list is where the
 *   near-synonyms live, and every byte here is shipped to a reader.
 *
 * Usage: node scripts/build-emoji.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(root, 'node_modules/emojibase-data', path), 'utf8'));

/** The languages the editor speaks — `@nbe/dom/src/i18n`. */
const LOCALES = ['en', 'fr', 'es', 'it', 'de'];
/** Skin tones and hair colours: modifiers, not emoji. */
const COMPONENT_GROUP = 2;
/** How many CLDR keywords to keep beside the name. */
const TAGS = 4;

/** `{ "0": "smileys-emotion", … }` — the group id a compact entry carries. */
const groupKeys = read('meta/groups.json').groups;
const q = (s) => JSON.stringify(s);

/**
 * English decides which emoji exist and in what order.
 *
 * @remarks
 * One reference list, so every locale comes out with the same groups holding
 * the same emoji at the same index — which is what lets `mergeCatalogues` pair
 * them by position instead of by hexcode at runtime. A locale missing a name
 * falls back to the English one rather than to a hole: an emoji nobody has
 * translated yet is still an emoji you can point at.
 */
const reference = read('en/compact.json');

for (const locale of LOCALES) {
  const data = read(`${locale}/compact.json`);
  const messages = read(`${locale}/messages.json`);
  const byHex = new Map(data.map((e) => [e.hexcode, e]));
  const label = (key) => messages.groups.find((g) => g.key === key)?.message ?? key;
  /** The name and its keywords, one string, the name first. */
  const words = (emoji) => [emoji.label, ...(emoji.tags ?? []).slice(0, TAGS)].join(', ');

  const buckets = new Map();
  for (const emoji of reference) {
    if (emoji.group === undefined || emoji.group === COMPONENT_GROUP) continue;
    if (!buckets.has(emoji.group)) buckets.set(emoji.group, []);
    buckets.get(emoji.group).push([emoji.order ?? 0, emoji.unicode, words(byHex.get(emoji.hexcode) ?? emoji)]);
  }

  const groups = [...buckets]
    .sort((a, b) => a[0] - b[0])
    .map(([group, items]) => {
      items.sort((a, b) => a[0] - b[0]);
      return (
        `  {\n    label: ${q(label(groupKeys[String(group)]))},\n    items: [\n` +
        items.map(([, unicode, names]) => `      [${q(unicode)}, ${q(names)}],`).join('\n') +
        '\n    ],\n  },'
      );
    });

  const count = [...buckets.values()].reduce((n, g) => n + g.length, 0);
  const file = `/**
 * Every emoji, named in \`${locale}\`.
 *
 * @remarks
 * **Generated** — \`node scripts/build-emoji.mjs\`, from CLDR's annotations by
 * way of \`emojibase-data\`. Do not edit by hand; edit the script and rerun it
 * for every language at once, because \`mergeCatalogues\` pairs the locales by
 * position and they have to stay in step.
 *
 * @module
 */
import type { EmojiGroup } from './index';

/** ${count} emoji, in ${buckets.size} groups. */
export const EMOJI_${locale.toUpperCase()}: readonly EmojiGroup[] = [
${groups.join('\n')}
];
`;
  writeFileSync(join(root, 'packages/emoji/src', `${locale}.ts`), file);
  console.log(`${locale}: ${count} emoji, ${(file.length / 1024) | 0} kB`);
}
