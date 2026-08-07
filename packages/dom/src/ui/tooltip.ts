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
 * all. The node is also dropped if the target leaves the DOM — chrome that
 * re-renders (toolbars, menus) would otherwise leave orphans floating.
 */
export function attachTooltip(
  target: HTMLElement,
  text: string | (() => string),
  options: TooltipOptions = {},
): () => void {
  const { delayMs = 450, ...position } = options;
  let timer = 0;
  let tip: HTMLElement | null = null;

  const hide = () => {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
  };

  const show = () => {
    if (!target.isConnected) return hide();
    tip ??= document.createElement('div');
    tip.className = 'nbe-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = typeof text === 'function' ? text() : text;
    mountPortal(tip);
    positionFloating(tip, target.getBoundingClientRect(), { placement: 'bottom-start', ...position });
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
