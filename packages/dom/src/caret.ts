import type { BlockId, TextSelection } from '@nbe/core';
import { getBlock, textLength } from '@nbe/core';
import type { EditorView } from './view';
import { domToModelPoint, leafOf } from './selection';

/**
 * Caret authority (the fix for every "caret is where I see it but typing goes
 * elsewhere" bug): the DOM selection is the source of truth for READING the
 * caret. The model selection is a mirror kept in sync at the entry of every
 * input path — never trusted over the DOM when both exist.
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
 * Re-derive the model selection from the DOM before acting on input. Call at
 * the top of beforeinput/keydown handlers: stale model state (missed
 * selectionchange, padding clicks, races) can then never misroute an edit.
 * Leaves block selections alone (they have no DOM selection).
 */
export function syncCaretFromDom(view: EditorView): void {
  if (view.composing) return;
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

/** Model offset closest to client point (x, y) inside a block's leaf. */
export function offsetAtPoint(view: EditorView, blockId: BlockId, x: number, y: number): number {
  const block = getBlock(view.editor.doc, blockId);
  const leaf = view.leafEl(blockId);
  if (!leaf) return 0;
  const rect = leaf.getBoundingClientRect();
  const cx = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const cy = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(cx, cy);
  if (pos) {
    const p = domToModelPoint(pos.offsetNode, pos.offset);
    if (p?.blockId === blockId) return p.offset;
  }
  const range = doc.caretRangeFromPoint?.(cx, cy);
  if (range) {
    const p = domToModelPoint(range.startContainer, range.startOffset);
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

const INTERACTIVE_CHROME =
  '.nbe-checkbox, .nbe-toggle-arrow, .nbe-image-input, .nbe-t-link_to_page, .nbe-t-image, [data-nbe-ui], a, button, input';

/**
 * Notion-style block click routing: pressing anywhere on a block's row —
 * padding, gutter, the empty area right of short text — places the caret at
 * the nearest text position instead of silently doing nothing (which left the
 * model selection stale and made later keystrokes land at the old spot).
 */
export function attachBlockClickRouting(view: EditorView): () => void {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (leafOf(target)) return; // inside an editable leaf: native caret is right
    if (target.closest?.(INTERACTIVE_CHROME)) return;
    const blockEl = target.closest?.('.nbe-block') as HTMLElement | null;
    const id = blockEl?.dataset['blockId'];
    if (!id || !view.editor.doc.blocks.has(id)) return;
    // route to this block's own leaf (not a descendant block's)
    const leaf = blockEl!.querySelector(':scope > .nbe-row > .nbe-leaf') as HTMLElement | null;
    if (!leaf) return;
    e.preventDefault();
    view.focusBlock(id, offsetAtPoint(view, id, e.clientX, e.clientY));
  };

  view.content.addEventListener('mousedown', onMouseDown);
  return () => view.content.removeEventListener('mousedown', onMouseDown);
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

