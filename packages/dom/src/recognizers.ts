import type { Point } from '@nbe/core';
import { textCaret } from '@nbe/core';
import type { EditorView } from './view';
import type { GestureRecognizer, GestureSession, PressContext } from './gestures';
import { leafOf, nativeRangeSpans } from './topology';
import { domToModelPoint, modelPointToDom } from './selection';
import { offsetAtPoint } from './caret';
import { canPaintCrossBlock } from './cross-block-highlight';
import { mountPortal } from './ui/portal';

/** Hand a cross-block range to the model, which paints it (D3). */
function extendToModel(view: EditorView, anchor: Point, head: Point): void {
  view.editor.setSelection({ kind: 'text', anchor, head }, 'dom');
}

/**
 * The arbitration story, as an ordered list. Registration order *is* the
 * precedence — explicit here instead of emerging from the order `view.ts`
 * happened to call `attach*` in.
 */

// ---------------------------------------------------------------- text drag

interface DomPoint {
  node: Node;
  offset: number;
}

/** Caret position under a client point, constrained to a leaf. */
function pointFromClient(view: EditorView, x: number, y: number): DomPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const resolve = (cx: number, cy: number): DomPoint | null => {
    const pos = doc.caretPositionFromPoint?.(cx, cy);
    if (pos && leafOf(pos.offsetNode)) return { node: pos.offsetNode, offset: pos.offset };
    const range = doc.caretRangeFromPoint?.(cx, cy);
    if (range && leafOf(range.startContainer)) return { node: range.startContainer, offset: range.startOffset };
    return null;
  };

  const direct = resolve(x, y);
  if (direct) return direct;

  // between blocks or over non-text chrome: fall back to the vertically
  // nearest leaf, so dragging through an image still extends the selection
  let best: { leaf: HTMLElement; distance: number; below: boolean } | null = null;
  for (const leaf of view.content.querySelectorAll<HTMLElement>('.nbe-leaf')) {
    const rect = leaf.getBoundingClientRect();
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (!best || distance < best.distance) best = { leaf, distance, below: y > rect.bottom };
  }
  if (!best) return null;
  const rect = best.leaf.getBoundingClientRect();
  const near = resolve(
    Math.min(Math.max(x, rect.left + 1), rect.right - 1),
    best.below ? rect.bottom - 2 : rect.top + 2,
  );
  return near ?? { node: best.leaf, offset: best.below ? best.leaf.childNodes.length : 0 };
}

/**
 * Selecting text, including across blocks.
 *
 * Inside one editing host the browser does this natively and better than we
 * would, so we stay out of the way entirely. Across hosts it will not: a
 * `Selection` is clamped to the host the gesture started in, measured in
 * Chromium 150 and 151 (`e2e/selection-topology.spec.ts`). `setBaseAndExtent`
 * does not escape it, and neither does any temporary toggle of editability —
 * the range dies the moment editability returns.
 *
 * So beyond that boundary the model carries the selection and the Highlight
 * API paints it (`cross-block-highlight.ts`). That works because a plain
 * `Range` spans hosts freely — only `Selection` is constrained — and because
 * every range command already operates on the model rather than on the DOM.
 *
 * Under a single-host topology `nativeRangeSpans` stays true and none of this
 * runs.
 */
export const textSelectRecognizer: GestureRecognizer = {
  name: 'text-select',
  match: (ctx) => !ctx.onChrome && ctx.host !== null && leafOf(ctx.target) !== null,
  start(ctx) {
    const { view, event } = ctx;

    // triple-click: the browser extends forward into the next block at offset
    // 0, which reads as a cross-block range the user never asked for
    if (event.detail >= 3) return leaveBlockMode(view);

    // Shift+click extends the existing selection, across blocks if needed
    if (event.shiftKey) {
      const head = pointFromClient(view, event.clientX, event.clientY);
      const current = view.editor.selection;
      const anchor = current?.kind === 'text' ? current.anchor : null;
      const to = head && domToModelPoint(head.node, head.offset);
      if (anchor && to) {
        event.preventDefault();
        if (anchor.blockId === to.blockId) {
          // one host: the browser holds it, and does the painting for free
          const from = modelPointToDom(view, anchor);
          if (from) document.getSelection()?.setBaseAndExtent(from.node, from.offset, head.node, head.offset);
        } else if (canPaintCrossBlock()) {
          extendToModel(view, anchor, to);
        }
      }
      return leaveBlockMode(view);
    }

    const anchor = pointFromClient(view, event.clientX, event.clientY);
    if (!anchor) return leaveBlockMode(view);
    leaveBlockMode(view);
    // a fresh press starts a new selection: drop any painted one, so the
    // remnant guard never outlives the gesture that needed it
    const held = view.editor.selection;
    if (held?.kind === 'text' && held.anchor.blockId !== held.head.blockId) {
      view.editor.setSelection(null, 'dom');
    }

    let crossed = false;
    return {
      mode: 'text',
      move(e) {
        const head = pointFromClient(view, e.clientX, e.clientY);
        if (!head) return;
        // inside one editing host the browser owns this natively and does it
        // better than we would; only take over once the drag leaves it
        if (!crossed && nativeRangeSpans(view.topology, anchor.node, head.node)) return;
        // without the Highlight API the range would be real but invisible, and
        // deleting text the user cannot see selected is worse than not selecting
        if (!canPaintCrossBlock()) return;
        crossed = true;
        e.preventDefault();
        // suppress the caret-drag autoscroll fight and the text-drag cursor
        document.body.classList.add('nbe-textdrag');

        /*
         * The browser refuses to hold a Selection across editing hosts — it
         * clamps to the one the drag started in, measured in Chromium 150/151.
         * So we stop asking it to hold one: the model carries the cross-block
         * range (which every command already operates on) and the Highlight
         * API paints it.
         */
        const from = domToModelPoint(anchor.node, anchor.offset);
        const to = domToModelPoint(head.node, head.offset);
        if (from && to) extendToModel(view, from, to);
      },
      end() {
        document.body.classList.remove('nbe-textdrag');
      },
    };
  },
};

/**
 * Pressing in editable text is what leaves block mode — decided here, where it
 * happens, instead of inferred later from a 500 ms window in `selectionchange`.
 */
function leaveBlockMode(view: EditorView): GestureSession {
  if (view.editor.selection?.kind === 'block') view.editor.setSelection(null, 'dom');
  return { mode: 'text' };
}

// --------------------------------------------------------- block click route

/**
 * Notion-style routing: pressing anywhere on a block's row — its padding, its
 * gutter, the empty area right of short text — places the caret at the nearest
 * text position instead of silently doing nothing, which used to leave the
 * model selection stale so later keystrokes landed at the old spot.
 */
export const blockClickRecognizer: GestureRecognizer = {
  name: 'block-click',
  match: (ctx) => !ctx.onChrome && ctx.host === null && ctx.blockId !== null,
  start(ctx) {
    const { view, event, blockEl, blockId } = ctx;
    // this block's own leaf, never a descendant block's
    const leaf = blockEl!.querySelector(':scope > .nbe-row > .nbe-leaf') as HTMLElement | null;
    if (!leaf) return null; // decline: let the rubber band or nothing take it
    event.preventDefault();
    view.editor.setSelection(
      textCaret(blockId!, offsetAtPoint(view, blockId!, event.clientX, event.clientY)),
      'api',
    );
    view.focusBlock(blockId!, offsetAtPoint(view, blockId!, event.clientX, event.clientY));
    return { mode: 'text' };
  },
};

// ---------------------------------------------------------------- rubber band

/**
 * Press on empty editor space and drag: top-level blocks intersecting the
 * band's vertical range become a block selection.
 */
export const rubberBandRecognizer: GestureRecognizer = {
  name: 'rubber-band',
  match(ctx) {
    if (ctx.onChrome) return false;
    // from empty editor space, or from an empty leaf — a placeholder paragraph
    // must not trap the gesture, since dragging out of it is how selection
    // starts after clicking into blank space
    const emptyLeaf = ctx.target.classList?.contains('nbe-leaf') && !ctx.target.textContent;
    return ctx.target === ctx.view.content || !!emptyLeaf;
  },
  start(ctx) {
    const { view, event } = ctx;
    const editor = view.editor;
    const origin = { x: event.clientX, y: event.clientY };
    const box = document.createElement('div');
    box.className = 'nbe-rubberband';
    let drawing = false;
    event.preventDefault();

    return {
      mode: 'block',
      move(e) {
        if (!drawing) {
          if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= 4) return;
          drawing = true;
          mountPortal(box);
          document.body.classList.add('nbe-drag-active');
        }
        // the browser also drag-selects text under the pointer; keep it hidden
        document.getSelection()?.removeAllRanges();
        const top = Math.min(origin.y, e.clientY);
        const bottom = Math.max(origin.y, e.clientY);
        box.style.top = `${top}px`;
        box.style.left = `${Math.min(origin.x, e.clientX)}px`;
        box.style.height = `${bottom - top}px`;
        box.style.width = `${Math.abs(e.clientX - origin.x)}px`;

        const hits = [...view.content.querySelectorAll<HTMLElement>(':scope > .nbe-block')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > top && r.top < bottom;
        });
        editor.setSelection(
          hits.length
            ? {
                kind: 'block',
                anchor: hits[0]!.dataset['blockId']!,
                head: hits[hits.length - 1]!.dataset['blockId']!,
              }
            : null,
          'dom', // no focus/scroll side effects while the band is live
        );
      },
      end(committed) {
        box.remove();
        document.body.classList.remove('nbe-drag-active');
        if (!drawing) return; // a plain click, not a band
        document.getSelection()?.removeAllRanges();
        const sel = editor.selection;
        if (committed && sel?.kind === 'block') editor.setSelection(sel, 'keyboard');
        else if (!committed) editor.setSelection(null, 'keyboard');
      },
    };
  },
};

/** Precedence, most specific first. This list is the arbitration story. */
export const defaultRecognizers: GestureRecognizer[] = [
  textSelectRecognizer,
  blockClickRecognizer,
  rubberBandRecognizer,
];
