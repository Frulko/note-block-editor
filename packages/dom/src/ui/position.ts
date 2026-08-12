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
  /**
   * Present as a bottom sheet when the pointer is a finger.
   *
   * @remarks
   * A menu anchored to a caret is a good shape for a mouse and a bad one for a
   * phone: it lands under the thumb that is already covering it, it is 240px
   * wide on a 390px screen, and its rows are 26px tall. The same list as a
   * sheet — full width, above the keyboard, thumb-sized rows — is the same
   * control, presented for the hand using it.
   *
   * Ignored where the pointer is fine, so nothing changes on a desktop.
   */
  sheet?: boolean;
}

/** True where the pointer is a finger: no hover, coarse targets. */
export function isTouchPointer(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/**
 * The part of the page a person can actually see, in client coordinates.
 *
 * @remarks
 * `window.innerHeight` is the *layout* viewport, and a software keyboard does
 * not resize it: everything placed against it is placed against a bottom edge
 * that is behind the keyboard. That is the whole of « le menu passe sous le
 * clavier » — the slash menu opened, was clamped to a screen bottom nobody can
 * see, and half of it was covered by the thing that had just been used to open
 * it.
 *
 * `visualViewport` is the one that shrinks, and it also carries the offset a
 * pinch-zoom leaves behind, so the answer stays right when the page is scaled.
 *
 * @category Interaction
 */
export function visibleViewport(): { top: number; left: number; width: number; height: number } {
  const vv = window.visualViewport;
  if (!vv) return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
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

/** Gap kept between a sheet and the edges of what can be seen. */
const SHEET_PAD = 8;

/**
 * Apply computePosition to a floating element already attached to <body>.
 *
 * @remarks
 * Everything here happens in the *visible* viewport rather than the layout one
 * — see {@link visibleViewport} — and the element is placed in page
 * coordinates, so the scroll offsets go back on at the end.
 */
export function positionFloating(el: HTMLElement, anchor: AnchorRect, opts?: PositionOptions): void {
  const view = visibleViewport();
  if (opts?.sheet && isTouchPointer()) {
    el.dataset['placement'] = 'sheet';
    el.style.left = `${view.left + SHEET_PAD + window.scrollX}px`;
    el.style.width = `${view.width - SHEET_PAD * 2}px`;
    // capped here rather than in CSS: `dvh` follows the browser's own bars and
    // knows nothing about a keyboard, which is the edge that matters
    el.style.maxHeight = `${Math.round(view.height * 0.45)}px`;
    // read *after* the width lands: a list that rewraps is a different height
    el.style.top = `${view.top + view.height - el.offsetHeight - SHEET_PAD + window.scrollY}px`;
    return;
  }
  // the same element may have been a sheet on a previous open (a hybrid laptop
  // switching pointer, a rotated tablet): hand the geometry back to the sheet
  el.style.width = '';
  el.style.maxHeight = '';
  const pos = computePosition(
    { top: anchor.top - view.top, bottom: anchor.bottom - view.top, left: anchor.left - view.left, right: anchor.right - view.left },
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: view.width, height: view.height },
    opts,
  );
  el.style.top = `${pos.top + view.top + window.scrollY}px`;
  el.style.left = `${pos.left + view.left + window.scrollX}px`;
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
  // the keyboard coming up resizes neither the window nor a scroller: it is a
  // visual-viewport event and nothing else, so a menu placed above it has to
  // hear this one or it stays where the keyboard now is
  const vv = window.visualViewport;
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  return () => {
    resizeObserver?.disconnect();
    window.removeEventListener('resize', update);
    document.removeEventListener('scroll', update, { capture: true });
    vv?.removeEventListener('resize', update);
    vv?.removeEventListener('scroll', update);
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
  /** The container's box, when the caller already measured it — two calls in a row cost two layouts. */
  box?: DOMRect,
): { x: number; y: number } {
  const rect = box ?? container.getBoundingClientRect();
  return { x: x - rect.left + container.scrollLeft, y: y - rect.top + container.scrollTop };
}
