import type { Mark, Run } from './types';
import { expandsForward, marksStack } from './marks';
import { prevGrapheme } from './grapheme';

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
 * And only the marks that *expand forward* (`marks.ts`). Continuing all of
 * them meant typing after a link extended the link and typing after inline
 * code stayed code — §2.2 says exactly the opposite, and had said so since
 * before the behaviour existed.
 */
export function marksAt(runs: Run[] | undefined, offset: number): Mark[] | undefined {
  if (!runs || offset === 0) return undefined;
  const text = runs.map((r) => r.text).join('');
  const slice = sliceRuns(runs, prevGrapheme(text, offset), offset);
  const carried = (slice[0]?.marks ?? []).filter((mark) => expandsForward(mark.type));
  return carried.length ? carried : undefined;
}
