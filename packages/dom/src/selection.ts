import type { Point } from '@nbe/core';
import { domSelectionIsRemnant } from './caret';
import type { EditorView } from './view';
import { leafOf } from './topology';

export { leafOf } from './topology';

/** Map a DOM position to a (blockId, offset) model point. */
export function domToModelPoint(node: Node, offset: number): Point | null {
  const leaf = leafOf(node);
  if (!leaf?.dataset['blockId']) return null;
  const range = document.createRange();
  range.selectNodeContents(leaf);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  // leaf text content maps 1:1 to model plain text (mark spans add no characters)
  return { blockId: leaf.dataset['blockId'], offset: range.toString().length };
}

export function modelPointToDom(view: EditorView, point: Point): { node: Node; offset: number } | null {
  const leaf = view.leafEl(point.blockId);
  if (!leaf) return null;
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  let remaining = point.offset;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = (node.textContent ?? '').length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: leaf, offset: leaf.childNodes.length };
}

/**
 * Keep the model selection in sync with the browser selection. Echo events
 * (from our own programmatic selection writes) resolve to the current model
 * selection and are dropped by equality — no fragile suppression counters.
 */
export function attachSelectionSync(view: EditorView): () => void {
  const handler = () => {
    if (view.composing) return;
    if (view.gesture?.mode === 'block') return; // a block gesture owns the selection
    const sel = document.getSelection();
    // Firefox still ships multi-range selections (bug 753718): only the
    // anchor/focus pair is meaningful, and the spec now caps others at one
    if (!sel || sel.rangeCount === 0) return;
    if (!view.content.contains(sel.anchorNode)) return;
    const anchor = domToModelPoint(sel.anchorNode!, sel.anchorOffset);
    const head = domToModelPoint(sel.focusNode!, sel.focusOffset);
    if (!anchor || !head) return;
    const prev = view.editor.selection;
    /*
     * A block selection has no DOM counterpart, and the browser keeps making
     * its own underneath — a caret dropped on mousedown, a range drag-selected
     * over non-editable content. Neither is intent to leave block mode, and
     * mapping either back is what made a rubber-band selection vanish on
     * release.
     *
     * Leaving block mode is now decided where it happens: the text recognizer
     * clears the block selection when a press lands in editable text. So by
     * the time this runs, a surviving block selection means the user has not
     * asked to leave it.
     */
    if (prev?.kind === 'block') return;
    // the browser's clamped remnant of a painted cross-block selection is not
    // the user's intent, and mapping it back would shrink their selection
    if (domSelectionIsRemnant(view)) return;
    if (
      prev?.kind === 'text' &&
      prev.anchor.blockId === anchor.blockId &&
      prev.anchor.offset === anchor.offset &&
      prev.head.blockId === head.blockId &&
      prev.head.offset === head.offset
    ) {
      return;
    }
    view.editor.setSelection({ kind: 'text', anchor, head }, 'dom');
  };
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
