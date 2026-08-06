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
    if (rect) positionFloating(el, rect, opts);
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
 * Close-on-outside-interaction, the rule every overlay must obey. Handles
 * pointer presses, Escape, and (optionally) focus leaving — in one place so
 * no overlay can forget one of the three.
 */
let lastDismiss: { target: Node; time: number } | null = null;

/**
 * True when the press that just closed an overlay happened inside `trigger`.
 *
 * A trigger button opening an overlay must TOGGLE it: without this, pressing
 * it again dismisses the overlay (outside press) and the click that follows
 * immediately reopens it, which reads as a broken button. Trigger handlers
 * call this and bail.
 */
export function dismissedBy(trigger: Node): boolean {
  if (!lastDismiss || Date.now() - lastDismiss.time > 400) return false;
  return trigger === lastDismiss.target || trigger.contains(lastDismiss.target);
}

export function dismissable(
  el: HTMLElement,
  close: () => void,
  options: { exempt?: (target: Node) => boolean; onEscape?: boolean } = {},
): () => void {
  const { exempt, onEscape = true } = options;
  const onPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (el.contains(target) || exempt?.(target)) return;
    lastDismiss = { target, time: Date.now() };
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (onEscape && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // pointerdown, not click: a press outside must dismiss before the click lands
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', close);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', close);
  };
}
