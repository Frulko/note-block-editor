import { positionFloating, type PositionOptions } from './position';
import { mountPortal } from './portal';

export interface TooltipOptions extends PositionOptions {
  delayMs?: number;
}

/**
 * Attach a tooltip to an element.
 *
 * Each target owns its tooltip node rather than sharing one module-level
 * element: with a shared node, one control hiding its tooltip removes the
 * node another control just showed, so tooltips flicker or never appear at
 * all.
 *
 * The node is also dropped when the target leaves the DOM, and *that* is the
 * hard half. A tooltip hides on `mouseleave` — but **an element removed from
 * the document never fires one**, and the chrome this is attached to is removed
 * all the time: the gutter hides when the pointer leaves a block, a toolbar
 * rebuilds, a menu closes. So the pointer moves away, the button vanishes, no
 * event arrives, and the label sits there pointing at nothing (reported
 * 2026-08-10, with a screenshot of « Commenter ce bloc » alone in the margin).
 *
 * Checking `isConnected` at show time was already here and could not catch it:
 * by then the tooltip is up, and the removal happens afterwards. So while one
 * is on screen — one at a time, and rarely — a frame loop watches for the
 * target going away. Cheap, and it needs no further gesture from the user,
 * which a "hide on the next pointermove" fix would.
 */
export function attachTooltip(
  target: HTMLElement,
  text: string | (() => string),
  options: TooltipOptions = {},
): () => void {
  const { delayMs = 450, ...position } = options;
  let timer = 0;
  let frame = 0;
  let tip: HTMLElement | null = null;

  const hide = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    tip?.remove();
    tip = null;
  };

  /** While the label is up, the target going away is what hides it. */
  const watch = () => {
    frame = requestAnimationFrame(() => {
      if (!tip) return;
      if (!target.isConnected) return hide();
      watch();
    });
  };

  const show = () => {
    if (!target.isConnected) return hide();
    tip ??= document.createElement('div');
    tip.className = 'nbe-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = typeof text === 'function' ? text() : text;
    mountPortal(tip);
    positionFloating(tip, target.getBoundingClientRect(), { placement: 'bottom-start', ...position });
    watch();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(show, delayMs);
  };

  target.addEventListener('mouseenter', schedule);
  target.addEventListener('focus', schedule);
  target.addEventListener('mouseleave', hide);
  target.addEventListener('blur', hide);
  target.addEventListener('pointerdown', hide);

  return () => {
    hide();
    target.removeEventListener('mouseenter', schedule);
    target.removeEventListener('focus', schedule);
    target.removeEventListener('mouseleave', hide);
    target.removeEventListener('blur', hide);
    target.removeEventListener('pointerdown', hide);
  };
}
