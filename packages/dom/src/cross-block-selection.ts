import type { EditorView } from './view';
import { leafOf, nativeRangeSpans } from './topology';
import { markTextIntent } from './caret';

/**
 * Native-feeling text selection across blocks (D3, upgraded).
 *
 * Empirically verified in Chromium/WebKit/Gecko: a DOM Range MAY span several
 * separate `contenteditable` hosts and the browser paints it normally — what
 * the browser refuses to do is *create* such a range from a mouse drag, since
 * it constrains drag-selection to the editing host the gesture started in.
 *
 * So we drive the gesture and let the browser do the painting: track the drag
 * ourselves and call `setBaseAndExtent` across leaves. This is lighter than
 * Gutenberg's approach of toggling `contentEditable` on a container during
 * selection (which then needs every key blocked while it is on), and unlike a
 * CSS Custom Highlight overlay it produces a REAL selection — so native copy,
 * find-on-page and screen readers keep working for free.
 */

interface DomPoint {
  node: Node;
  offset: number;
  leaf: HTMLElement;
}

/** Caret position under a client point, constrained to an editable leaf. */
function pointFromClient(view: EditorView, x: number, y: number): DomPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const resolve = (cx: number, cy: number): DomPoint | null => {
    const pos = doc.caretPositionFromPoint?.(cx, cy);
    if (pos) {
      const leaf = leafOf(pos.offsetNode);
      if (leaf) return { node: pos.offsetNode, offset: pos.offset, leaf };
    }
    const range = doc.caretRangeFromPoint?.(cx, cy);
    if (range) {
      const leaf = leafOf(range.startContainer);
      if (leaf) return { node: range.startContainer, offset: range.startOffset, leaf };
    }
    return null;
  };

  const direct = resolve(x, y);
  if (direct) return direct;

  // the pointer is between blocks or over non-text chrome: fall back to the
  // vertically nearest leaf so dragging through an image or a divider still
  // extends the selection instead of stalling
  const leaves = [...view.content.querySelectorAll<HTMLElement>('.nbe-leaf')];
  let best: { leaf: HTMLElement; distance: number; below: boolean } | null = null;
  for (const leaf of leaves) {
    const rect = leaf.getBoundingClientRect();
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (!best || distance < best.distance) best = { leaf, distance, below: y > rect.bottom };
  }
  if (!best) return null;
  const leaf = best.leaf;
  const clampedX = Math.min(Math.max(x, leaf.getBoundingClientRect().left + 1), leaf.getBoundingClientRect().right - 1);
  const rect = leaf.getBoundingClientRect();
  const near = resolve(clampedX, best.below ? rect.bottom - 2 : rect.top + 2);
  if (near) return near;
  return { node: leaf, offset: best.below ? leaf.childNodes.length : 0, leaf };
}

export function attachCrossBlockSelection(view: EditorView): () => void {
  let anchor: DomPoint | null = null;
  let dragging = false;
  let crossed = false;

  const stop = () => {
    dragging = false;
    anchor = null;
    crossed = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('nbe-textdrag');
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging || !anchor) return;
    const head = pointFromClient(view, e.clientX, e.clientY);
    if (!head) return;
    // when the browser can span these two natively, it already is: stay out
    // of its way. Single-host topology makes that always true, which switches
    // this driver off without it needing to know why.
    if (!crossed && nativeRangeSpans(view.topology, anchor.node, head.node)) return;
    crossed = true;
    e.preventDefault();
    // suppress the caret-drag autoscroll fight and text-drag cursor
    document.body.classList.add('nbe-textdrag');
    const sel = document.getSelection();
    if (!sel) return;
    try {
      sel.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      /* a node was replaced mid-drag; the next move re-resolves it */
    }
  };

  const onUp = () => stop();

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const leaf = leafOf(e.target as Node);
    if (!leaf) return; // margin presses belong to the rubber band (block selection)
    // triple-click: the browser extends forward into the next block at offset
    // 0, which reads as a cross-block range the user never asked for
    if (e.detail >= 3) {
      markTextIntent();
      return;
    }

    // Shift+click extends the existing selection, across blocks if needed
    if (e.shiftKey) {
      const sel = document.getSelection();
      const head = pointFromClient(view, e.clientX, e.clientY);
      if (sel && sel.rangeCount && head && sel.anchorNode) {
        e.preventDefault();
        try {
          sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, head.node, head.offset);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    markTextIntent(); // a press in text means the user wants a caret there
    anchor = pointFromClient(view, e.clientX, e.clientY);
    if (!anchor) return;
    dragging = true;
    crossed = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  view.content.addEventListener('pointerdown', onPointerDown);
  return () => {
    stop();
    view.content.removeEventListener('pointerdown', onPointerDown);
  };
}
