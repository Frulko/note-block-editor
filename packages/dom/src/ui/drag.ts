export interface DraggableOptions {
  /** Movement in px before a press becomes a drag (default 4). */
  thresholdPx?: number;
  /** Press released under the threshold — a click, not a drag. */
  onTap?: (e: PointerEvent) => void;
  /** Drag passed the threshold. Return false to abort the session. */
  onStart: (e: PointerEvent) => boolean | void;
  onMove: (e: PointerEvent) => void;
  onDrop: (e: PointerEvent) => void;
  onCancel: () => void;
  /** Scroll container for edge auto-scroll during the drag. */
  scrollContainer?: () => Element | null;
  /** Distance from the viewport edge where auto-scroll kicks in (default 90). */
  autoScrollEdge?: number;
}

/**
 * Pointer-based drag session (in-house by decision D8: native HTML5 DnD can't
 * start from touch, has unstylable previews and broken auto-scroll — see
 * docs/research/hard-interactions.md). Threshold press-vs-drag, Escape
 * cancellation, rAF edge auto-scroll. Ghosts/guides belong to the caller.
 */
export function draggable(handle: HTMLElement, opts: DraggableOptions): () => void {
  const threshold = opts.thresholdPx ?? 4;
  const edge = opts.autoScrollEdge ?? 90;
  let start: { x: number; y: number } | null = null;
  let active = false;
  let lastY = 0;
  let raf = 0;
  let scrollEl: Element | null = null;

  const scrollLoop = () => {
    if (!active) return;
    if (scrollEl) {
      const vh = window.innerHeight;
      if (lastY < edge) scrollEl.scrollTop -= (edge - lastY) / 6;
      else if (lastY > vh - edge) scrollEl.scrollTop += (lastY - (vh - edge)) / 6;
    }
    raf = requestAnimationFrame(scrollLoop);
  };

  const stop = () => {
    cancelAnimationFrame(raf);
    active = false;
    start = null;
    document.removeEventListener('keydown', onKey, { capture: true });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      e.stopPropagation();
      stop();
      opts.onCancel();
    }
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers have no capture */
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!start) return;
    if (!active) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= threshold) return;
      if (opts.onStart(e) === false) {
        start = null;
        return;
      }
      active = true;
      scrollEl = opts.scrollContainer?.() ?? null;
      document.addEventListener('keydown', onKey, { capture: true });
      raf = requestAnimationFrame(scrollLoop);
    }
    lastY = e.clientY;
    opts.onMove(e);
  };

  const onUp = (e: PointerEvent) => {
    if (active) {
      stop();
      opts.onDrop(e);
    } else if (start) {
      start = null;
      opts.onTap?.(e);
    }
  };

  const onCancelEvt = () => {
    if (active) {
      stop();
      opts.onCancel();
    } else {
      start = null;
    }
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancelEvt);
  return () => {
    stop();
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancelEvt);
  };
}

/** Nearest scrollable ancestor (falls back to the document scroller). */
export function findScrollParent(from: Element): Element {
  for (let n: Element | null = from; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement ?? document.documentElement;
}
