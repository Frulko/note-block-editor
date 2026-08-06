import type { Mark, Run } from './types';

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

/** Add or remove a mark over [from, to). Existing marks of the same type are replaced. */
export function applyMark(runs: Run[], from: number, to: number, mark: Mark, add: boolean): Run[] {
  const len = textLength(runs);
  const mid = sliceRuns(runs, from, to).map((r) => {
    const marks = (r.marks ?? []).filter((m) => m.type !== mark.type);
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

/** Marks at the caret: those of the character before `offset` (Notion behavior). */
export function marksAt(runs: Run[] | undefined, offset: number): Mark[] | undefined {
  if (!runs || offset === 0) return undefined;
  const slice = sliceRuns(runs, offset - 1, offset);
  return slice[0]?.marks;
}
