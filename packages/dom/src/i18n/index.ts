/**
 * The languages the editor speaks, and how a host chooses one.
 *
 * @remarks
 * **English is the default**, and French is a pack like any other. That is a
 * deliberate reversal: the editor was written in French because its first host
 * is, but a library whose defaults are one team's language is a library
 * everyone else has to translate before they can read their own screen. A host
 * says which language it wants; Carnet says `fr`.
 *
 * Each pack is a complete {@link EditorLabels}, never a patch over another — a
 * partial dictionary falls back silently to a language the reader may not
 * have, which is how an interface ends up speaking two at once. The type makes
 * a missing key a build error rather than a surprise on screen.
 *
 * Nothing here is loaded unless it is imported: five packs are five modules,
 * and a host that names one bundles one.
 *
 * @example
 * ```ts
 * import { de } from '@nbe/dom'
 * new EditorView(el, editor, { labels: de })
 * ```
 *
 * @module
 */
import type { EditorLabels } from '../labels';
import { en } from './en';
import { fr } from './fr';
import { es } from './es';
import { it } from './it';
import { de } from './de';

export { en, fr, es, it, de };

/** The languages that ship. */
export const LOCALES = { en, fr, es, it, de } as const;

export type LocaleCode = keyof typeof LOCALES;

/** For a picker: the code and the language's name in itself. */
export const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  de: 'Deutsch',
};

/**
 * The pack for a code, English for anything else.
 *
 * @remarks
 * Takes a full BCP-47 tag too — `fr-CA` and `de-AT` get the language, because
 * a host reading a system setting should not have to know that this editor
 * only varies by language.
 */
export function labelsFor(code: string): EditorLabels {
  const language = code.toLowerCase().split(/[-_]/)[0] as LocaleCode;
  return LOCALES[language] ?? en;
}
