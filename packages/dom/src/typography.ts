/**
 * The face the prose is set in, as a choice a host can offer.
 *
 * @remarks
 * Three, the same three Notion offers, and for the same reason: a note is read
 * as an interface, as a document, or as a listing, and one face cannot be right
 * for all three. Anything past three is a font picker, which is a different
 * feature and belongs to whoever wants it — `--nbe-font-body` is one custom
 * property and a host can set it to anything.
 *
 * It is an attribute rather than an option, which is the pattern every other
 * host-facing appearance choice here already follows (`data-nbe-theme`,
 * `data-nbe-code-theme`): it needs no option threaded through three packages,
 * and it reaches the chrome portaled out of the editor as well as the page.
 *
 * ```ts
 * import { TYPEFACES } from '@nbe/dom'
 * document.body.dataset.nbeTypeface = 'serif'
 * ```
 *
 * **Only the prose changes.** Code stays monospaced whatever the page is set
 * in: a listing in Georgia is a listing whose columns no longer line up, and
 * the whole reason a code block is monospaced is that its columns mean
 * something.
 *
 * @module
 */

/**
 * One of the faces a page can be set in.
 *
 * @remarks
 * The stack itself is deliberately absent: it lives in `style/tokens.css`,
 * where the design charter keeps every font stack and where
 * `test/design.test.ts` fails the build over one spelled anywhere else. This
 * table is what a picker is built from, and the id is what the attribute takes.
 *
 * @category Configuration
 */
export interface Typeface {
  /** The value for `data-nbe-typeface`. */
  id: string;
  label: string;
}

/**
 * The three that ship. The first is the default and needs no attribute.
 *
 * @remarks
 * The labels are the same three words in every language this editor speaks, so
 * they are not in `EditorLabels` — a translation table whose five entries would
 * be identical is a table nobody maintains. Which also means no accent, which
 * `packages/dom/test/i18n.test.ts` enforces on every module here: an accented
 * literal is a string that shows up in French inside a German app.
 *
 * @category Configuration
 */
export const TYPEFACES: readonly Typeface[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
];
