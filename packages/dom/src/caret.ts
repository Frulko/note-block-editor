import type { BlockId, TextSelection } from '@nbe/core';
import { getBlock, textLength } from '@nbe/core';
import type { EditorView } from './view';
import { domToModelPoint, modelPointToDom } from './selection';
import { leafOf } from './topology';

/**
 * Caret authority (the fix for every "caret is where I see it but typing goes
 * elsewhere" bug): the DOM selection is the source of truth for READING the
 * caret. The model selection is a mirror kept in sync at the entry of every
 * input path — never trusted over the DOM when both exist.
 *
 * A BLOCK selection has no DOM counterpart, so a caret the browser drops on
 * its own must not be mistaken for user intent — that arbitration now lives in
 * the gesture router, which knows what is actually happening rather than
 * inferring it from how recently something was pressed.
 */

/** Map the live DOM selection to a model text selection (null when unusable). */
export function domTextSelection(view: EditorView): TextSelection | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  if (!view.content.contains(sel.anchorNode)) return null;
  const anchor = domToModelPoint(sel.anchorNode!, sel.anchorOffset);
  const head = domToModelPoint(sel.focusNode!, sel.focusOffset);
  if (!anchor || !head) return null;
  return { kind: 'text', anchor, head };
}

/**
 * The clamped remnant of a painted cross-block selection.
 *
 * @remarks
 * The browser refuses to hold a `Selection` across editing hosts, so a
 * cross-block selection is carried by the model and painted (D3). But the
 * browser still holds the *clamped* single-block selection its drag produced,
 * and every DOM→model sync would map that remnant back — silently shrinking
 * the user's selection to its first block the moment they pressed a key.
 *
 * The remnant is recognised by its *shape* rather than by recording it: the
 * clamp keeps the anchor the drag started from and truncates the head into
 * that anchor's block. Anything else — a click elsewhere, a keyboard move — is
 * the user asking for something else, and the DOM wins again.
 *
 * Shape, not a recorded snapshot, because recording races: the browser updates
 * its own selection *after* our pointermove handler runs, so a snapshot taken
 * when the model was set is already stale. Measured — a drag delivered as a
 * single pointermove (a fast flick) lost its selection entirely that way.
 */
export function domSelectionIsRemnant(view: EditorView): boolean {
  const sel = view.editor.selection;
  if (sel?.kind !== 'text' || sel.anchor.blockId === sel.head.blockId) return false;
  const dom = domTextSelection(view);
  return (
    !!dom &&
    dom.anchor.blockId === sel.anchor.blockId &&
    dom.anchor.offset === sel.anchor.offset &&
    dom.head.blockId === sel.anchor.blockId
  );
}

/**
 * Re-derive the model selection from the DOM before acting on input. Call at
 * the top of beforeinput/keydown handlers: stale model state (missed
 * selectionchange, padding clicks, races) can then never misroute an edit.
 * Leaves block selections alone: they have no DOM counterpart, and the caret
 * the browser keeps in the still-focused leaf is not the user leaving them.
 */
export function syncCaretFromDom(view: EditorView): void {
  if (view.composing) return;
  /*
   * A block selection has no DOM counterpart, but the leaf it came from keeps
   * focus and the browser keeps a caret inside it — so this used to derive a
   * text selection and overwrite the block one, before the keymap had even
   * looked at the key. Measured 2026-08-07: Escape selected a block and the
   * very next Shift+ArrowDown dropped the selection and extended text
   * instead, which killed the whole block-mode key contract.
   *
   * `attachSelectionSync` already refused this; the two paths had drifted.
   */
  if (view.editor.selection?.kind === 'block') return;
  if (domSelectionIsRemnant(view)) return;
  const derived = domTextSelection(view);
  if (!derived) return;
  const prev = view.editor.selection;
  if (
    prev?.kind === 'text' &&
    prev.anchor.blockId === derived.anchor.blockId &&
    prev.anchor.offset === derived.anchor.offset &&
    prev.head.blockId === derived.head.blockId &&
    prev.head.offset === derived.head.offset
  ) {
    return;
  }
  view.editor.setSelection(derived, 'dom');
}

/**
 * The DOM position under a client point — checked, not trusted.
 *
 * @remarks
 * `caretPositionFromPoint` and `caretRangeFromPoint` both take *viewport*
 * coordinates by specification, and WebKit has a long history of treating them
 * as *document* coordinates instead. The symptom is a caret that lands
 * correctly at the top of a document and drifts further the more the page is
 * scrolled — reported from the desktop build, whose webview is WebKit, while
 * every browser test passed because Chromium follows the specification.
 *
 * Rather than ask which engine this is, the answer is verified: the position
 * a lookup returns has a rectangle, and that rectangle must contain the point
 * that was asked about. When it does not, the same lookup is retried with the
 * document scroll added — the exact error a document-relative reading makes —
 * and whichever answer verifies is the one used.
 *
 * Measuring rather than sniffing matters here because the quirk is version
 * dependent: a WebKit that fixes it would silently break a correction keyed to
 * the engine's name, and this one simply stops applying.
 */
export function caretFromClientPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const lookup = (px: number, py: number): { node: Node; offset: number } | null => {
    const position = doc.caretPositionFromPoint?.(px, py);
    if (position) return { node: position.offsetNode, offset: position.offset };
    const range = doc.caretRangeFromPoint?.(px, py);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  };

  /** Does this position actually sit at the point we asked about? */
  const holds = (found: { node: Node; offset: number }): boolean => {
    try {
      const probe = document.createRange();
      probe.setStart(found.node, found.offset);
      probe.setEnd(found.node, found.offset);
      const rect = probe.getBoundingClientRect();
      if (!rect.height) return true; // nothing to compare against: accept it
      // one line of tolerance, so a click between lines still counts
      return y >= rect.top - rect.height && y <= rect.bottom + rect.height;
    } catch {
      return true; // an offset we cannot probe is not evidence of a fault
    }
  };

  const direct = lookup(x, y);
  if (direct && holds(direct)) return direct;

  const scrolled = window.scrollX || window.scrollY ? lookup(x + window.scrollX, y + window.scrollY) : null;
  if (scrolled && holds(scrolled)) return scrolled;
  return direct ?? scrolled;
}

/** Model offset closest to client point (x, y) inside a block's leaf. */
export function offsetAtPoint(view: EditorView, blockId: BlockId, x: number, y: number): number {
  const block = getBlock(view.editor.doc, blockId);
  const leaf = view.leafEl(blockId);
  if (!leaf) return 0;
  const rect = leaf.getBoundingClientRect();
  const cx = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const cy = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
  const found = caretFromClientPoint(cx, cy);
  if (found) {
    const p = domToModelPoint(found.node, found.offset);
    if (p?.blockId === blockId) return p.offset;
  }
  // clamped point failed to map (rare): end for right-side clicks, start otherwise
  return x > rect.right - rect.width / 2 ? textLength(block.text) : 0;
}

/** Model offset closest to `x` on the first or last visual line of a block. */
export function offsetAtX(view: EditorView, blockId: BlockId, x: number, edge: 'first' | 'last'): number {
  const leaf = view.leafEl(blockId);
  if (!leaf) return 0;
  const rect = leaf.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(leaf).lineHeight) || 24;
  const y =
    edge === 'first'
      ? Math.min(rect.top + line / 2, rect.bottom - 2)
      : Math.max(rect.bottom - line / 2, rect.top + 2);
  return offsetAtPoint(view, blockId, x, y);
}

/** A press anywhere outside the editor drops a block selection. */
export function attachOutsidePressDeselect(view: EditorView): () => void {
  const onDocumentPointerDown = (e: PointerEvent) => {
    if (view.editor.selection?.kind !== 'block') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (view.content.contains(target) || target.closest?.('[data-nbe-ui]')) return;
    view.editor.setSelection(null, 'keyboard');
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);
  return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
}

/** Collapsed-caret client X for goal-X seeding (DOM truth, robust fallbacks). */
export function caretClientX(view: EditorView): number | null {
  const s = document.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const range = s.getRangeAt(0);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
  if (rect && (rect.width !== 0 || rect.height !== 0 || rect.top !== 0)) return rect.left;
  return leafOf(range.startContainer)?.getBoundingClientRect().left ?? null;
}

/**
 * Where a trigger menu points: at the character that opened it.
 *
 * @remarks
 * The leaf's own rect starts at the left edge of the block, so typing `/` in
 * the middle of a sentence opened the palette back at the margin — nowhere
 * near the caret, which is where the eye is. A collapsed `Range` at the
 * trigger offset is the character's own box.
 *
 * Falls back to the leaf when the range reports nothing, which is what an
 * empty leaf does, and returns `null` once the leaf is gone so `autoUpdate`
 * leaves the menu where it was instead of clamping it to the corner.
 */
export function triggerAnchor(view: EditorView, blockId: BlockId, offset: number): DOMRect | null {
  const leaf = view.leafEl(blockId);
  if (!leaf) return null;
  const at = modelPointToDom(view, { blockId, offset });
  if (at) {
    try {
      const range = document.createRange();
      range.setStart(at.node, at.offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.height) return rect;
    } catch {
      /* the leaf was replaced between the model read and this frame */
    }
  }
  return leaf.getBoundingClientRect();
}
