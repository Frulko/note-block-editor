import type { Mark, Run } from './types';
import { expandsForward, marksStack } from './marks';
import { nextGrapheme, prevGrapheme } from './grapheme';

export function textLength(runs: Run[] | undefined): number {
  if (!runs) return 0;
  let n = 0;
  for (const r of runs) n += r.text.length;
  return n;
}

export function plainText(runs: Run[] | undefined): string {
  if (!runs) return '';
  return runs.map((r) => r.text).join('');
}

function markKey(m: Mark): string {
  return m.type + (m.attrs ? JSON.stringify(m.attrs) : '');
}

export function marksEq(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  const ka = (a ?? []).map(markKey).sort();
  const kb = (b ?? []).map(markKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function cloneRun(r: Run): Run {
  return { text: r.text, marks: r.marks?.length ? r.marks.map((m) => ({ ...m })) : undefined };
}

/** Merge adjacent runs with identical mark sets, drop empty runs. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && marksEq(last.marks, r.marks)) last.text += r.text;
    else out.push(cloneRun(r));
  }
  return out;
}

export function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const start = pos;
    const end = pos + r.text.length;
    pos = end;
    if (end <= from || start >= to) continue;
    const s = Math.max(from, start) - start;
    const e = Math.min(to, end) - start;
    out.push({ text: r.text.slice(s, e), marks: r.marks?.map((m) => ({ ...m })) });
  }
  return normalizeRuns(out);
}

export function spliceRuns(runs: Run[], from: number, to: number, insert: Run[]): Run[] {
  const len = textLength(runs);
  return normalizeRuns([...sliceRuns(runs, 0, from), ...insert, ...sliceRuns(runs, to, len)]);
}

/** Add or remove a mark over [from, to). A mark of the same type is replaced,
 * unless the type stacks — see {@link @nbe/core!MarkSpec.multiple}. */
export function applyMark(runs: Run[], from: number, to: number, mark: Mark, add: boolean): Run[] {
  const len = textLength(runs);
  /*
   * Applying a mark replaces any mark of the same type on the range — right
   * for a mark that *is* its type, wrong for one that stacks. A second comment
   * on a paragraph is the normal case, and it used to take the first thread's
   * anchor away. `MarkSpec.multiple` says which is which; when it is set, only
   * a mark with the same `attrs` is replaced, so a thread still cannot anchor
   * itself twice.
   */
  const stacks = marksStack(mark.type);
  const same = (m: Mark) => JSON.stringify(m.attrs ?? {}) === JSON.stringify(mark.attrs ?? {});
  const mid = sliceRuns(runs, from, to).map((r) => {
    const marks = (r.marks ?? []).filter((m) => m.type !== mark.type || (stacks && !same(m)));
    if (add) marks.push({ ...mark });
    return { text: r.text, marks: marks.length ? marks : undefined };
  });
  return normalizeRuns([...sliceRuns(runs, 0, from), ...mid, ...sliceRuns(runs, to, len)]);
}

/**
 * Where the caret has to go to get *out* of the span it is inside.
 *
 * @returns The offset just past the span, or null when the caret is not inside
 * one — at an edge included, since an edge is already outside.
 *
 * @remarks
 * Only for the marks that do not expand forward: code, a link, a mention. Once
 * the interior of such a span continues it (see {@link marksAt}), the end of
 * the span is the only way out by typing — which is right, and is also a thing
 * you can be several characters away from. This is what Escape uses to make it
 * one press.
 *
 * @category Rich text
 */
export function spanExit(runs: Run[] | undefined, offset: number): number | null {
  const mark = marksAt(runs, offset)?.find((m) => !expandsForward(m.type));
  if (!runs || !mark) return null;
  const key = markKey(mark);
  let at = 0;
  let end: number | null = null;
  for (const run of runs) {
    const next = at + run.text.length;
    // the run holding the caret, then every one after it that is the same span
    if (next > offset && (run.marks ?? []).some((m) => markKey(m) === key)) end = next;
    else if (end !== null) break;
    at = next;
  }
  return end;
}

/** True if the entire [from, to) range carries a mark of this type. */
export function hasMark(runs: Run[], from: number, to: number, type: string): boolean {
  const slice = sliceRuns(runs, from, to);
  if (slice.length === 0) return false;
  return slice.every((r) => (r.marks ?? []).some((m) => m.type === type));
}

/**
 * Marks the next typed character should carry.
 *
 * @remarks
 * Those of the character before `offset` — the character, not the code unit.
 * Stepping back one unit from after an emoji lands inside it, and a slice that
 * starts mid-surrogate carries no run at all, so typing after an emoji lost
 * whatever formatting it had.
 *
 * Then two rules, and the order matters.
 *
 * **Inside a span, everything continues.** A mark carried by the character on
 * *both* sides has no edge here: the caret is in the middle of it, and text
 * typed there is unambiguously part of it. Expansion is a rule about
 * boundaries — Peritext's whole subject — and applying it in the interior is
 * what made putting the caret in the middle of `` `const x` `` and typing
 * produce a code span, a plain character, and another code span. The same was
 * true of typing inside a link's text.
 *
 * **At an edge, `expand` decides.** Continuing every mark of the preceding
 * character meant typing after a link extended the link and typing after
 * inline code stayed code — §2.2 says the opposite, and had said so since
 * before the behaviour existed. That is still the rule at the end of a span,
 * which is also how you get *out* of one: keep typing.
 */
export function marksAt(runs: Run[] | undefined, offset: number): Mark[] | undefined {
  if (!runs || offset === 0) return undefined;
  const text = runs.map((r) => r.text).join('');
  const before = sliceRuns(runs, prevGrapheme(text, offset), offset)[0]?.marks ?? [];
  // the character after, by the same grapheme-safe step, so "is this the
  // interior of the span" is asked of a whole character rather than half of one
  const ahead =
    offset >= text.length ? [] : (sliceRuns(runs, offset, nextGrapheme(text, offset))[0]?.marks ?? []);
  const inside = new Set(ahead.map(markKey));
  const carried = before.filter((mark) => inside.has(markKey(mark)) || expandsForward(mark.type));
  return carried.length ? carried : undefined;
}
