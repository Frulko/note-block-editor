import { LoroText } from 'loro-crdt';
import type { Mark, Run } from '@nbe/core';

/**
 * Rich text as a CRDT container, so two people can type in one paragraph.
 *
 * @remarks
 * Storing runs as a *value* — which the first adapter did — means two people
 * editing the same paragraph conflict on the whole paragraph: last write wins,
 * and a sentence disappears. `LoroText` merges by position instead, so edits at
 * different points in the same line both survive.
 *
 * **The store receives results, not operations**, and that is the whole
 * difficulty. `set(id, block)` hands over the finished run array; replacing the
 * container with it would be one enormous replacement per keystroke and would
 * throw away everything the CRDT is for. So the text is *diffed*: a keystroke
 * differs from the previous state by one character, which becomes one insert
 * at one position — the operation Loro wants, recovered from the value we were
 * given.
 *
 * A prefix/suffix diff is enough because that is the shape of typing. It is
 * not a minimal edit script for arbitrary rewrites: a paste that changes the
 * middle of a paragraph produces one replacement spanning the change, which
 * merges worse than it could and is still correct.
 *
 * @category Collaboration
 */

/** The plain text of a run array. */
export function plainOf(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join('');
}

/** Loro attributes for a run: mark type to its attributes, or `true`. */
function attributesOf(run: Run): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mark of run.marks ?? []) out[mark.type] = mark.attrs ?? true;
  return out;
}

/** The marks a delta's attributes describe. */
function marksOf(attributes: Record<string, unknown> | undefined): Mark[] | undefined {
  if (!attributes) return undefined;
  const marks: Mark[] = Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== false)
    .map(([type, value]) =>
      value === true ? { type } : { type, attrs: value as Record<string, unknown> },
    );
  return marks.length ? marks : undefined;
}

/** Read a container back as runs. */
export function textToRuns(text: LoroText): Run[] {
  const runs: Run[] = [];
  for (const part of text.toDelta()) {
    const inserted = (part as { insert?: unknown }).insert;
    if (typeof inserted !== 'string') continue;
    const marks = marksOf((part as { attributes?: Record<string, unknown> }).attributes);
    runs.push(marks ? { text: inserted, marks } : { text: inserted });
  }
  return runs;
}

/** Where two strings stop agreeing, from each end. */
function diffRange(before: string, after: string): { start: number; deleted: number; inserted: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return {
    start,
    deleted: before.length - start - end,
    inserted: after.slice(start, after.length - end),
  };
}

/**
 * Make a container hold `runs`, editing rather than replacing.
 *
 * @remarks
 * Marks are re-applied over the whole text each time. They are cheap next to
 * the content, and computing a minimal mark diff would be a second edit script
 * for a gain nobody has measured — the note to revisit is here rather than the
 * optimisation.
 */
export function applyRuns(text: LoroText, runs: readonly Run[]): void {
  const before = text.toString();
  const after = plainOf(runs);

  if (before !== after) {
    const { start, deleted, inserted } = diffRange(before, after);
    if (deleted > 0) text.delete(start, deleted);
    if (inserted) text.insert(start, inserted);
  }

  if (!after.length) return;

  /*
   * Unmark first, then mark. A mark removed from a run would otherwise survive
   * because marking never clears anything it does not name — which is how a
   * word stays bold after the bold is switched off.
   */
  const present = new Set<string>();
  for (const run of runs) for (const mark of run.marks ?? []) present.add(mark.type);
  for (const part of text.toDelta()) {
    for (const type of Object.keys((part as { attributes?: object }).attributes ?? {})) present.add(type);
  }

  let offset = 0;
  const wanted = new Map<string, Array<{ start: number; end: number; value: unknown }>>();
  for (const run of runs) {
    const attributes = attributesOf(run);
    for (const [type, value] of Object.entries(attributes)) {
      const ranges = wanted.get(type) ?? [];
      const last = ranges[ranges.length - 1];
      // merge with the previous range when it is adjacent and identical
      if (last && last.end === offset && JSON.stringify(last.value) === JSON.stringify(value)) last.end += run.text.length;
      else ranges.push({ start: offset, end: offset + run.text.length, value });
      wanted.set(type, ranges);
    }
    offset += run.text.length;
  }

  for (const type of present) {
    const ranges = wanted.get(type) ?? [];
    text.unmark({ start: 0, end: after.length }, type);
    for (const range of ranges) text.mark({ start: range.start, end: range.end }, type, range.value as never);
  }
}

export { LoroText };
