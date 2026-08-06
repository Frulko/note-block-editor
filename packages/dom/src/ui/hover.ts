export interface HoverZoneOptions {
  /** Resolve the hovered logical target from a pointer position (geometry-based, not event-target-based). */
  resolve: (e: MouseEvent) => HTMLElement | null;
  /** Floating chrome (controls, tooltips, menus): hovering it keeps the current target alive. */
  isChrome?: (target: EventTarget | null) => boolean;
  onTarget: (target: HTMLElement) => void;
  onClear: () => void;
  /** Delay before clearing once the pointer leaves everything (survives gaps). */
  graceMs?: number;
}

export interface HoverZone {
  /** Suspend target switching (menu open, drag in progress). */
  freeze(on: boolean): void;
  /** Clear immediately. */
  hide(): void;
  destroy(): void;
}

/**
 * Hover controller for block chrome. Fixes the classic hover loss: listens on
 * document (not the content element), resolves targets by geometry so the
 * left margin still hovers the adjacent block, keeps the target while the
 * pointer is over the floating chrome, and hides only after a grace delay.
 */
export function createHoverZone(opts: HoverZoneOptions): HoverZone {
  const graceMs = opts.graceMs ?? 300;
  let current: HTMLElement | null = null;
  let frozen = false;
  let timer = 0;

  const clear = () => {
    current = null;
    opts.onClear();
  };

  const scheduleClear = () => {
    clearTimeout(timer);
    timer = window.setTimeout(clear, graceMs);
  };

  const onMove = (e: MouseEvent) => {
    if (frozen) return;
    if (opts.isChrome?.(e.target)) {
      clearTimeout(timer);
      return;
    }
    const target = opts.resolve(e);
    if (target === current) {
      if (target) clearTimeout(timer);
      else if (current) scheduleClear();
      return;
    }
    if (target) {
      clearTimeout(timer);
      current = target;
      opts.onTarget(target);
    } else {
      scheduleClear();
    }
  };

  const onLeaveDoc = () => {
    if (!frozen) scheduleClear();
  };

  document.addEventListener('mousemove', onMove, { passive: true });
  document.documentElement.addEventListener('mouseleave', onLeaveDoc);

  return {
    freeze(on) {
      frozen = on;
      if (on) clearTimeout(timer);
    },
    hide() {
      clearTimeout(timer);
      clear();
    },
    destroy() {
      clearTimeout(timer);
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeaveDoc);
    },
  };
}
