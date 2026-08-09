export type Placement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end'
  | 'left-start'
  | 'right-start';

export interface PositionOptions {
  placement?: Placement;
  /** Gap between anchor and floating element (px). */
  offset?: number;
  /** Minimum distance from viewport edges (px). */
  padding?: number;
}

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Pure positioning: viewport-relative coordinates for a floating element.
 * Flips to the opposite side when the preferred side overflows and the other
 * side fits; always clamps inside the viewport padding. (Micro floating-ui —
 * ponytail: no shift/arrow middleware until a real need appears.)
 */
export function computePosition(
  anchor: AnchorRect,
  size: Size,
  viewport: Size,
  opts: PositionOptions = {},
): { top: number; left: number; placement: Placement } {
  const { placement = 'bottom-start', offset = 6, padding = 8 } = opts;
  const [side, align] = placement.split('-') as [string, 'start' | 'end'];
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  if (side === 'bottom' || side === 'top') {
    let finalSide = side;
    let top = side === 'bottom' ? anchor.bottom + offset : anchor.top - size.height - offset;
    const fitsBelow = anchor.bottom + offset + size.height <= viewport.height - padding;
    const fitsAbove = anchor.top - offset - size.height >= padding;
    if (side === 'bottom' && !fitsBelow && fitsAbove) {
      top = anchor.top - size.height - offset;
      finalSide = 'top';
    } else if (side === 'top' && !fitsAbove && fitsBelow) {
      top = anchor.bottom + offset;
      finalSide = 'bottom';
    }
    top = clamp(top, padding, viewport.height - size.height - padding);
    let left = align === 'end' ? anchor.right - size.width : anchor.left;
    left = clamp(left, padding, viewport.width - size.width - padding);
    return { top, left, placement: `${finalSide}-${align}` as Placement };
  }

  let finalSide = side;
  let left = side === 'right' ? anchor.right + offset : anchor.left - size.width - offset;
  const fitsRight = anchor.right + offset + size.width <= viewport.width - padding;
  const fitsLeft = anchor.left - offset - size.width >= padding;
  if (side === 'right' && !fitsRight && fitsLeft) {
    left = anchor.left - size.width - offset;
    finalSide = 'left';
  } else if (side === 'left' && !fitsLeft && fitsRight) {
    left = anchor.right + offset;
    finalSide = 'right';
  }
  left = clamp(left, padding, viewport.width - size.width - padding);
  const top = clamp(anchor.top, padding, viewport.height - size.height - padding);
  return { top, left, placement: `${finalSide}-start` as Placement };
}

/** Apply computePosition to a floating element already attached to <body>. */
export function positionFloating(el: HTMLElement, anchor: AnchorRect, opts?: PositionOptions): void {
  const pos = computePosition(
    anchor,
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    opts,
  );
  el.style.top = `${pos.top + window.scrollY}px`;
  el.style.left = `${pos.left + window.scrollX}px`;
  el.dataset['placement'] = pos.placement;
}

/**
 * Keep a floating element glued to a live anchor across scroll, viewport
 * resize, anchor movement AND its own content changing size.
 *
 * That last one is what makes filtering menus behave: a menu placed above its
 * anchor is positioned from its own height, so when the list shrinks to one
 * item the box must move back DOWN or it visibly floats away from what it is
 * attached to. A ResizeObserver on the floating element catches every such
 * change — content edits, images loading, fonts swapping — without the caller
 * having to remember to reposition.
 */
export function autoUpdate(
  el: HTMLElement,
  getAnchor: () => AnchorRect | null,
  opts?: PositionOptions,
): () => void {
  const update = () => {
    const rect = getAnchor();
    /*
     * A detached anchor measures all-zero, which is truthy and would clamp the
     * floater to the viewport corner — leave it where it was instead.
     *
     * All-zero, though, not merely empty: a *point* anchor is legitimate — a
     * caret, a corner of the editor — and the earlier test (any zero
     * dimension) rejected every one of them, so the find bar and the export
     * menu were mounted and then never positioned at all.
     */
    const detached = !rect || (!rect.top && !rect.left && !rect.right && !rect.bottom);
    if (!detached) positionFloating(el, rect, opts);
  };
  update();

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
  resizeObserver?.observe(el);

  window.addEventListener('resize', update);
  document.addEventListener('scroll', update, { capture: true, passive: true });
  return () => {
    resizeObserver?.disconnect();
    window.removeEventListener('resize', update);
    document.removeEventListener('scroll', update, { capture: true });
  };
}

/**
 * Convert a viewport point into coordinates inside a positioned container.
 *
 * @remarks
 * Chrome anchored to a *block* — the hover gutter, the per-block toolbar —
 * belongs in the editor's own coordinate space rather than on `document.body`.
 * Mounted outside it, three things went wrong at once and were reported
 * together on 2026-08-07: it did not follow the editor's own scrolling (only
 * the window's), it was positioned once on hover and never again, and nothing
 * stopped it being placed outside the editor entirely — the gutter sat in the
 * host page, left of the editor card.
 *
 * Inside the container all three stop being possible: it scrolls because it is
 * part of what scrolls, it moves with its block because it is measured against
 * the same box, and it cannot escape a box it lives in.
 *
 * Floating chrome that must *break out* — menus, the drag ghost, popovers over
 * a clipping ancestor — still uses `positionFloating` and `ui/portal.ts`.
 *
 * @param container - A positioned element (`position: relative` or better).
 * Assumes no border, which holds for `.nbe-editor`: `getBoundingClientRect`
 * measures the border box while absolute children resolve against the padding
 * box.
 */
export function toContainerPoint(
  container: HTMLElement,
  x: number,
  y: number,
): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  return { x: x - rect.left + container.scrollLeft, y: y - rect.top + container.scrollTop };
}
