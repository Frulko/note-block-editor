/**
 * How a mark behaves at its edges.
 *
 * @remarks
 * §2.2 says each mark type declares Peritext expansion semantics — "bold
 * expands at boundaries, links do not" — and calls it dormant metadata, cheap
 * to declare now and needed when CRDTs arrive. Auditing Loro for phase 5 found
 * that it had never been declared: marks were `type: string` with no registry
 * anywhere. The document described something that did not exist.
 *
 * It turns out not to be dormant at all. `marksAt` continues every mark of the
 * preceding character, so typing after a link extended the link and typing
 * after inline code stayed code — both wrong, both visible today, both fixed by
 * the metadata that was supposed to be for later.
 *
 * The names match Loro's `configTextStyle`, which takes exactly this per-mark
 * configuration (`{ bold: { expand: "after" }, link: { expand: "none" } }`).
 * That is not a coincidence: both follow Peritext, which is why §2.2 chose to
 * record it early.
 *
 * @category Rich text
 */

/**
 * Which side of a mark absorbs text typed against it.
 *
 * - `after` — typing at the end continues the mark. What emphasis should do.
 * - `before` — typing at the start continues it.
 * - `both` — either edge.
 * - `none` — the mark keeps exactly the characters it was applied to.
 */
export type MarkExpansion = 'none' | 'before' | 'after' | 'both';

export interface MarkSpec {
  type: string;
  expand: MarkExpansion;
  /**
   * Whether several of these may cover the same text, told apart by `attrs`.
   *
   * @remarks
   * Applying a mark replaces any mark of the same type on that range, which is
   * right for every mark that *is* its type — text is bold or it is not, and a
   * second link on the same words is a mistake. It is wrong for a comment: two
   * people discussing the same paragraph is the normal case, and replacing
   * meant the second thread silently took the first one's anchor, dropping a
   * live discussion into the orphan list while the block it was about was
   * still there.
   *
   * @defaultValue false
   */
  multiple?: boolean;
}

/**
 * The closed mark set of §2.2, with its edge behaviour.
 *
 * @remarks
 * Emphasis expands after, so continuing to type continues the emphasis —
 * which is what every editor does and what a user expects. The others do not,
 * for reasons that differ:
 *
 * - a **link** has a target; text typed after it is not part of that target,
 *   and silently extending the anchor is how a stray word ends up clickable;
 * - **code** is a span with a boundary a reader relies on;
 * - a **mention** resolves a live page title (§2.4) — it is one thing, and
 *   typing beside it must not grow it.
 */
export const MARKS: readonly MarkSpec[] = [
  { type: 'bold', expand: 'after' },
  { type: 'italic', expand: 'after' },
  { type: 'underline', expand: 'after' },
  { type: 'strike', expand: 'after' },
  { type: 'superscript', expand: 'after' },
  { type: 'subscript', expand: 'after' },
  { type: 'color', expand: 'after' },
  { type: 'background', expand: 'after' },
  { type: 'code', expand: 'none' },
  { type: 'link', expand: 'none' },
  { type: 'mention', expand: 'none' },
  /*
   * A comment marks the text someone was talking about. Typing next to it must
   * not drag the anchor along, or a thread quietly comes to cover a sentence
   * nobody commented on — the same reason links do not expand, and worse here,
   * because the discussion stays attached while its subject changes.
   */
  { type: 'comment', expand: 'none', multiple: true },
];

const BY_TYPE = new Map(MARKS.map((spec) => [spec.type, spec]));

/**
 * How a mark expands, defaulting to `after`.
 *
 * @remarks
 * An unknown mark — one a plugin added — is treated as emphasis, because that
 * is what most marks are and because continuing to type inside formatting you
 * just applied is the less surprising failure. A plugin that needs otherwise
 * says so by registering.
 */
export function markExpansion(type: string): MarkExpansion {
  return BY_TYPE.get(type)?.expand ?? 'after';
}

/** Register or override a mark's edge behaviour, for a plugin's own mark. */
export function registerMark(spec: MarkSpec): void {
  BY_TYPE.set(spec.type, spec);
}

/** True when typing *after* this mark should continue it. */
export function expandsForward(type: string): boolean {
  const expand = markExpansion(type);
  return expand === 'after' || expand === 'both';
}

/** True when several of these marks may cover the same text (see {@link MarkSpec.multiple}). */
export function marksStack(type: string): boolean {
  return BY_TYPE.get(type)?.multiple === true;
}
