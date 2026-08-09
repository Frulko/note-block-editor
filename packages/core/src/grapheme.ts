/**
 * Perceived characters, not code units (AQ#4).
 *
 * @remarks
 * §2.2 fixes the coordinate system as `(blockId, offset)` with offsets in
 * UTF-16 code units, which is what the DOM speaks and therefore the only
 * honest choice. But a *user* does not edit code units. They edit what looks
 * like one character, and several things that look like one character are not:
 *
 * - an emoji outside the BMP is two code units (a surrogate pair),
 * - a family emoji is several of those joined by zero-width joiners,
 * - a flag is two regional-indicator letters,
 * - `é` typed on some keyboards is `e` followed by a combining accent,
 * - Devanagari and Thai form clusters with no single-code-point form at all.
 *
 * The old delete path handled the surrogate pair and nothing else, with a
 * comment saying so: a family emoji took four presses of Backspace, leaving
 * visible debris on the way. This module is what makes one press mean one
 * character.
 *
 * `Intl.Segmenter` does the actual work — it implements UAX #29, which is a
 * table nobody should be maintaining by hand. Where it is missing the old
 * surrogate-pair behaviour returns, so an ancient engine degrades to what it
 * did before rather than breaking.
 *
 * @category Text
 */

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** True when this engine can segment properly rather than by surrogate pair. */
export const GRAPHEME_AWARE = segmenter !== null;

/**
 * How much text either side of an offset is enough to segment it correctly.
 *
 * @remarks
 * Segmenting a whole block per keystroke is fine at the sizes a block reaches,
 * but not at the sizes a *paste* reaches — and correctness only needs local
 * context, because a cluster is bounded. 128 code units is far past the
 * longest sequence Unicode defines, so a window that big gives the same answer
 * as the whole string while staying constant-time.
 */
const WINDOW = 128;

/** Cluster boundaries within `text`, as offsets, including 0 and `length`. */
export function graphemeBoundaries(text: string): number[] {
  const out = [0];
  if (!segmenter) {
    for (let i = 0; i < text.length; ) {
      const code = text.charCodeAt(i);
      i += code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1;
      out.push(i);
    }
    return out;
  }
  for (const { index } of segmenter.segment(text)) if (index > 0) out.push(index);
  // guarded, or empty text would report the boundary 0 twice and count as one
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

/** Segment a window around `offset` and report boundaries in the original. */
function nearbyBoundaries(text: string, offset: number): { boundaries: number[]; base: number } {
  const start = Math.max(0, offset - WINDOW);
  const end = Math.min(text.length, offset + WINDOW);
  // never start inside a surrogate pair, or the window itself would bisect one
  const base = start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
  return { boundaries: graphemeBoundaries(text.slice(base, end)), base };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The offset one perceived character before `offset`.
 *
 * @returns `offset` itself when already at the start, so a caller can tell
 * "nothing to delete" from "deleted nothing".
 */
export function prevGrapheme(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const { boundaries, base } = nearbyBoundaries(text, offset);
  const local = offset - base;
  let previous = 0;
  for (const boundary of boundaries) {
    if (boundary >= local) break;
    previous = boundary;
  }
  return base + previous;
}

/** The offset one perceived character after `offset`. */
export function nextGrapheme(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const { boundaries, base } = nearbyBoundaries(text, offset);
  const local = offset - base;
  for (const boundary of boundaries) if (boundary > local) return base + boundary;
  return text.length;
}

/**
 * Move an offset onto the nearest cluster boundary.
 *
 * @remarks
 * An offset can land mid-cluster without anyone intending it: a paste, a
 * remote operation, a selection the browser reported, a caret restored from a
 * bookmark after the text around it changed. Applying an edit there splits a
 * character into halves that render as replacement glyphs, and no later edit
 * puts them back.
 *
 * @param prefer - Which way to round. `'back'` for the start of a range,
 * `'forward'` for its end, so snapping only ever *grows* a range and never
 * silently drops a character the user selected.
 */
export function snapGrapheme(text: string, offset: number, prefer: 'back' | 'forward' = 'back'): number {
  const clamped = Math.max(0, Math.min(text.length, offset));
  if (clamped === 0 || clamped === text.length) return clamped;
  const { boundaries, base } = nearbyBoundaries(text, clamped);
  const local = clamped - base;
  if (boundaries.includes(local)) return clamped;
  if (prefer === 'back') {
    let previous = 0;
    for (const boundary of boundaries) {
      if (boundary >= local) break;
      previous = boundary;
    }
    return base + previous;
  }
  for (const boundary of boundaries) if (boundary > local) return base + boundary;
  return text.length;
}

/** How many perceived characters `text` contains. */
export function graphemeLength(text: string): number {
  return graphemeBoundaries(text).length - 1;
}

/**
 * Words, for `⌥⌫` and its siblings.
 *
 * @remarks
 * The same table, at a different granularity — and the reason to use it rather
 * than scan for spaces is that half the world does not put spaces between
 * words. UAX #29 knows where a word ends in Japanese, Thai and Chinese; a
 * whitespace scan would delete the whole sentence.
 */
const wordSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/**
 * Where a backward word-delete should stop, from `offset`.
 *
 * @remarks
 * Trailing spaces go with the word, which is what a native text field does:
 * `⌥⌫` in `"le monde|"` leaves `"le "`, and again leaves `"le "` → `""` rather
 * than stalling on the space.
 */
export function prevWord(text: string, offset: number): number {
  const head = text.slice(0, Math.max(0, Math.min(text.length, offset)));
  if (!head) return 0;
  if (!wordSegmenter) {
    let i = head.length;
    while (i > 0 && /\s/.test(head[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(head[i - 1]!)) i--;
    return i;
  }
  let start = 0;
  for (const seg of wordSegmenter.segment(head)) if (seg.isWordLike) start = seg.index;
  return start;
}

/** Where a forward word-delete should stop, from `offset`. */
export function nextWord(text: string, offset: number): number {
  const from = Math.max(0, Math.min(text.length, offset));
  const tail = text.slice(from);
  if (!tail) return text.length;
  if (!wordSegmenter) {
    let i = 0;
    while (i < tail.length && /\s/.test(tail[i]!)) i++;
    while (i < tail.length && !/\s/.test(tail[i]!)) i++;
    return from + i;
  }
  for (const seg of wordSegmenter.segment(tail)) {
    if (seg.isWordLike) return from + seg.index + seg.segment.length;
  }
  return text.length;
}
