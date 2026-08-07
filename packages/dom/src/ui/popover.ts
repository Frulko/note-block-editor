import { autoUpdate, type AnchorRect, type PositionOptions } from './position';
import { mountPortal } from './portal';
import { pushOverlay } from './overlay';

/**
 * A floating panel with arbitrary content.
 *
 * `menu.ts` was doing two jobs: a keyboard-navigable list, and the generic
 * "something floats next to this anchor" container. So every non-list overlay
 * — the image drop zone, the formula editor, a property panel — had to
 * pretend to be a menu item by passing `{ kind: 'custom', el }`. That is the
 * escape hatch becoming the API, in miniature: a block plugin wanting a small
 * form had no honest way to ask for one.
 *
 * A popover is the container without the list: positioning, the overlay stack,
 * and nothing else. `createMenu` keeps the list behaviour and is now one
 * *kind* of popover rather than the only floating thing that exists.
 */

export interface PopoverOptions {
  className?: string;
  /** Nodes outside the panel that still count as inside — usually the trigger. */
  isOutsideExempt?: (target: Node) => boolean;
  onClose?: () => void;
}

export interface PopoverController {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  /** `getAnchor` is re-read on scroll and resize, so it survives re-renders. */
  open(getAnchor: () => AnchorRect | null, position?: PositionOptions): void;
  setContent(content: Node): void;
  close(): void;
}

export function createPopover(opts: PopoverOptions = {}): PopoverController {
  const el = document.createElement('div');
  el.className = 'nbe-popover' + (opts.className ? ` ${opts.className}` : '');
  el.dataset['nbeUi'] = '';
  // a popover floats over editable content; pressing inside must not move the
  // caret out of the block the user is acting on
  el.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) e.preventDefault();
  });

  let open = false;
  let stopAuto: (() => void) | null = null;
  let stopOverlay: (() => void) | null = null;

  const close = () => {
    if (!open) return;
    open = false;
    stopAuto?.();
    stopAuto = null;
    stopOverlay?.();
    stopOverlay = null;
    el.remove();
    opts.onClose?.();
  };

  return {
    el,
    get isOpen() {
      return open;
    },
    open(getAnchor, position) {
      if (open) return;
      open = true;
      mountPortal(el);
      stopAuto = autoUpdate(el, getAnchor, position);
      stopOverlay = pushOverlay({ el, close, exempt: opts.isOutsideExempt });
    },
    setContent(content) {
      el.replaceChildren(content);
    },
    close,
  };
}
