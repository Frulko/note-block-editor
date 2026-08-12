import { suppressNextClick } from './overlay';

export interface DraggableOptions {
  /**
   * Decide at press time whether this press may become a drag. Returning
   * false leaves the event completely alone — no preventDefault, no tracking
   * — so attaching a drag source to a large container (the editor content)
   * cannot break text selection on the parts that are not drag handles.
   */
  canStart?: (e: PointerEvent) => boolean;
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
 * Pointer-based drag session (in-house by decision D8 — see
 * docs/research/hard-interactions.md).
 *
 * Robustness rules learned the hard way:
 * - move/up/cancel listen on `window`, not the handle: if the handle is
 *   hidden, re-rendered or detached mid-drag, the session still ends.
 * - pointer capture is attempted as an extra (it keeps events flowing when
 *   the pointer leaves the window) but is never relied upon.
 * - the session also ends on Escape, pointercancel, window blur, and a
 *   second pointer going down — a drag can never be left dangling.
 * - callbacks are exception-safe: a throw in onMove/onDrop still runs the
 *   caller's cancel path instead of freezing the page in drag state.
 */
export function draggable(handle: HTMLElement, opts: DraggableOptions): () => void {
  const threshold = opts.thresholdPx ?? 4;
  const edge = opts.autoScrollEdge ?? 90;
  let start: { x: number; y: number; pointerId: number } | null = null;
  let active = false;
  let lastEvent: PointerEvent | null = null;
  let raf = 0;
  let scrollEl: Element | null = null;

  const scrollLoop = () => {
    if (!active) return;
    if (scrollEl && lastEvent) {
      const vh = window.innerHeight;
      const y = lastEvent.clientY;
      let scrolled = false;
      if (y < edge) {
        scrollEl.scrollTop -= (edge - y) / 6;
        scrolled = true;
      } else if (y > vh - edge) {
        scrollEl.scrollTop += (y - (vh - edge)) / 6;
        scrolled = true;
      }
      // keep drop target and guide glued to the content while it scrolls under
      // a stationary pointer
      if (scrolled) safe(() => opts.onMove(lastEvent!));
    }
    raf = requestAnimationFrame(scrollLoop);
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      teardown();
      try {
        opts.onCancel();
      } catch {
        /* cancel must never throw the page into a stuck state */
      }
      throw err;
    }
  };

  const teardown = () => {
    cancelAnimationFrame(raf);
    active = false;
    start = null;
    lastEvent = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('pointerdown', onSecondPointer, { capture: true });
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('keydown', onKey, { capture: true });
  };

  const cancel = () => {
    const wasActive = active;
    teardown();
    if (wasActive) opts.onCancel();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  const onBlur = () => cancel();
  const onPointerCancel = () => cancel();
  const onSecondPointer = (e: PointerEvent) => {
    if (start && e.pointerId !== start.pointerId) cancel();
  };

  const onMove = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.pointerId) return;
    if (!active) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= threshold) return;
      let ok: boolean | void = false;
      safe(() => {
        ok = opts.onStart(e);
      });
      if (ok === false) {
        teardown();
        return;
      }
      active = true;
      scrollEl = opts.scrollContainer?.() ?? null;
      raf = requestAnimationFrame(scrollLoop);
    }
    lastEvent = e;
    safe(() => opts.onMove(e));
  };

  const onUp = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.pointerId) return;
    const wasActive = active;
    teardown();
    if (wasActive) {
      try {
        opts.onDrop(e);
      } catch (err) {
        opts.onCancel();
        throw err;
      }
    } else {
      /*
       * A tap acts here, on `pointerup` — before the browser synthesises the
       * click that follows a touch. Whatever the tap opens is therefore on
       * screen when that click lands, and on a phone it opens *under the
       * finger*: tapping the block handle opened the menu as a sheet and the
       * ghost click chose a row of it before it had been read.
       *
       * Only for a finger: a mouse's click is the user's, and every tap
       * handler in the editor is reached by one or the other, never both.
       */
      if (e.pointerType !== 'mouse') suppressNextClick();
      opts.onTap?.(e);
    }
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || start) return;
    if (opts.canStart && !opts.canStart(e)) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    try {
      handle.setPointerCapture(e.pointerId); // best-effort: survives off-window release
    } catch {
      /* synthetic pointers have no capture */
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('pointerdown', onSecondPointer, { capture: true });
    window.addEventListener('blur', onBlur);
    document.addEventListener('keydown', onKey, { capture: true });
  };

  handle.addEventListener('pointerdown', onDown);
  return () => {
    cancel();
    handle.removeEventListener('pointerdown', onDown);
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

export interface DragMechanicsOptions {
  thresholdPx?: number;
  autoScrollEdge?: number;
  scrollContainer?: () => Element | null;
  /** Crossing the threshold. Return false to abandon the drag. */
  onStart: (e: PointerEvent) => boolean | void;
  onMove: (e: PointerEvent) => void;
  onDrop: () => void;
  onCancel: () => void;
}

/**
 * The two things a router-owned drag still needs: a movement threshold and
 * edge auto-scroll.
 *
 * Everything else `draggable()` does — window-level listeners, Escape, blur,
 * pointercancel, exception safety, teardown — the gesture router already
 * provides, so a recognizer must not re-implement it. This is the shared
 * remainder, extracted rather than copied.
 */
export function dragMechanics(
  origin: { clientX: number; clientY: number },
  opts: DragMechanicsOptions,
): { move: (e: PointerEvent) => void; end: (committed: boolean) => void } {
  const threshold = opts.thresholdPx ?? 4;
  const edge = opts.autoScrollEdge ?? 90;
  let active = false;
  let abandoned = false;
  let lastEvent: PointerEvent | null = null;
  let scrollEl: Element | null = null;
  let raf = 0;

  const scrollLoop = () => {
    if (!active) return;
    if (scrollEl && lastEvent) {
      const y = lastEvent.clientY;
      const vh = window.innerHeight;
      let scrolled = false;
      if (y < edge) {
        scrollEl.scrollTop -= (edge - y) / 6;
        scrolled = true;
      } else if (y > vh - edge) {
        scrollEl.scrollTop += (y - (vh - edge)) / 6;
        scrolled = true;
      }
      // keep the drop target glued to content scrolling under a still pointer
      if (scrolled) opts.onMove(lastEvent);
    }
    raf = requestAnimationFrame(scrollLoop);
  };

  return {
    move(e) {
      if (abandoned) return;
      if (!active) {
        if (Math.hypot(e.clientX - origin.clientX, e.clientY - origin.clientY) <= threshold) return;
        if (opts.onStart(e) === false) {
          abandoned = true;
          return;
        }
        active = true;
        scrollEl = opts.scrollContainer?.() ?? null;
        raf = requestAnimationFrame(scrollLoop);
      }
      lastEvent = e;
      opts.onMove(e);
    },
    end(committed) {
      cancelAnimationFrame(raf);
      if (!active) return; // never crossed the threshold: a click, not a drag
      active = false;
      if (committed) opts.onDrop();
      else opts.onCancel();
    },
  };
}
