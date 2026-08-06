import { positionFloating, type PositionOptions } from './position';

let tipEl: HTMLElement | null = null;

function tip(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'nbe-tooltip';
    tipEl.setAttribute('role', 'tooltip');
  }
  return tipEl;
}

export interface TooltipOptions extends PositionOptions {
  delayMs?: number;
}

/**
 * Attach a tooltip to an element (single shared tooltip node). Shows after a
 * delay on hover/focus, hides on leave/blur/press. Returns cleanup.
 */
export function attachTooltip(
  target: HTMLElement,
  text: string | (() => string),
  opts: TooltipOptions = {},
): () => void {
  const { delayMs = 450, ...position } = opts;
  let timer = 0;

  const show = () => {
    const el = tip();
    el.textContent = typeof text === 'function' ? text() : text;
    document.body.append(el);
    positionFloating(el, target.getBoundingClientRect(), { placement: 'bottom-start', ...position });
  };
  const hide = () => {
    clearTimeout(timer);
    tipEl?.remove();
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
