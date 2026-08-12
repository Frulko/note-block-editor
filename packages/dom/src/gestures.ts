import type { BlockId } from '@nbe/core';
import type { EditorView } from './view';
import { suppressNextClick } from './ui/overlay';

/**
 * One press, one owner.
 *
 * Five modules used to listen for pointerdown on the same surface and each
 * decide, by sniffing the target, whether the press was theirs. Nothing
 * arbitrated: precedence was whatever order `view.ts` happened to attach them
 * in, and two could start on the same press. Worse, they coordinated through
 * wall-clock windows — `textIntentActive()` at 500 ms, `justRubberBanded()` at
 * 300 ms — because they had no shared notion of what was currently happening.
 * Every one of those was a real bug fix, and every one was timing-fragile: a
 * slow frame moved the boundary and the bug came back as an unreproducible
 * flake.
 *
 * The router classifies a press once, hands it to exactly one recognizer, and
 * publishes what is running. Modules ask about state instead of guessing from
 * timestamps.
 */

export interface PressContext {
  event: PointerEvent;
  view: EditorView;
  target: HTMLElement;
  /** The editable host under the pointer, per the view's topology. */
  host: HTMLElement | null;
  /** Nearest block element and id, if the press landed on one. */
  blockEl: HTMLElement | null;
  blockId: BlockId | null;
  /** The press landed on interactive chrome (checkbox, link, overlay UI…). */
  onChrome: boolean;
}

export interface GestureSession {
  /**
   * What the editor is doing, for anyone who needs to arbitrate.
   * `block` means the DOM selection is not user intent and must be ignored.
   */
  readonly mode: 'text' | 'block';
  move?(e: PointerEvent): void;
  /** Ends the gesture. `committed` is false for Escape/cancel/blur. */
  end?(committed: boolean): void;
}

export interface GestureRecognizer {
  name: string;
  /** Cheap predicate; `start` may still decline by returning null. */
  match(ctx: PressContext): boolean;
  start(ctx: PressContext): GestureSession | null;
}

export interface ActiveGesture {
  readonly name: string;
  readonly mode: 'text' | 'block';
  /** True once the pointer has moved past the drag threshold. */
  moved: boolean;
}

/**
 * How far a press may drift and still be a click, in CSS pixels.
 *
 * A mouse moves a pixel or two between button-down and button-up — a trackpad
 * always does. `moved` fed `suppressNextClick()`, so without a threshold that
 * drift swallowed the click: clicking the empty page below the last block to
 * keep writing worked only if the pointer had been perfectly still. Same
 * number the rubber band already used before it starts drawing.
 */
const DRAG_SLOP = 4;

const INTERACTIVE_CHROME =
  '.nbe-checkbox, .nbe-toggle-arrow, .nbe-callout-icon, .nbe-t-link_to_page, .nbe-t-image, [data-nbe-ui], a, button, input, textarea, select';

/*
 * The click a moved gesture leaves behind is swallowed by
 * {@link suppressNextClick}, which used to live here.
 *
 * This is what `justRubberBanded()`'s 300 ms window existed for: a drag that
 * ended over empty space must not also register as "click below the last block
 * to append a paragraph". A touch tap has the same problem for a different
 * reason — see the note on the function itself — so the one implementation now
 * sits in `ui/overlay.ts`, beside the other answers to "what does a press
 * dismiss".
 */

export function attachGestureRouter(view: EditorView): () => void {
  let session: GestureSession | null = null;
  let origin = { x: 0, y: 0 };

  const finish = (committed: boolean) => {
    const current = session;
    const active = view.gesture;
    session = null;
    view.gesture = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
    document.removeEventListener('keydown', onKey, true);
    if (active?.moved) suppressNextClick();
    try {
      current?.end?.(committed);
    } catch (err) {
      // a throwing recognizer must not leave the page in gesture state
      console.error('[nbe] gesture end failed', err);
    }
    // anything that must wait for a gesture to settle listens here instead of
    // guessing with a timeout — the floating format toolbar is the reason
    for (const cb of [...view.gestureEndListeners]) {
      try {
        cb(active?.name ?? '', committed);
      } catch (err) {
        console.error('[nbe] gesture end listener failed', err);
      }
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!session || !view.gesture) return;
    // recognizers still see every move — they do their own thresholding — but
    // `moved` is what decides a click was really a drag, so it waits for slop
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > DRAG_SLOP) view.gesture.moved = true;
    try {
      session.move?.(e);
    } catch (err) {
      console.error('[nbe] gesture move failed', err);
      finish(false);
    }
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !session) return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || session) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;

    origin = { x: e.clientX, y: e.clientY };
    const blockEl = target.closest?.('.nbe-block') as HTMLElement | null;
    const blockId = blockEl?.dataset['blockId'] ?? null;
    const ctx: PressContext = {
      event: e,
      view,
      target,
      host: view.topology.hostOf(target),
      blockEl,
      blockId: blockId && view.editor.doc.blocks.has(blockId) ? blockId : null,
      onChrome: !!target.closest?.(INTERACTIVE_CHROME),
    };

    // read lazily: a feature can contribute a recognizer after the router is
    // attached, so precedence stops depending on module attach order
    for (const recognizer of view.recognizers) {
      if (!recognizer.match(ctx)) continue;
      const started = recognizer.start(ctx);
      if (!started) continue; // declined; the next one may take it
      session = started;
      view.gesture = { name: recognizer.name, mode: started.mode, moved: false };
      /*
       * Capture the pointer, so the gesture survives the finger or cursor
       * leaving the element it started on. On touch this is not a nicety: the
       * browser otherwise claims the sequence for scrolling and delivers
       * `pointercancel`, which is why dragging a block by its handle did
       * nothing at all on a phone — measured, no drop indicator and no move.
       * Capture alone is not enough; the chrome that starts a drag also needs
       * `touch-action: none`, which is in `chrome.css`.
       *
       * **Except for a mouse selecting text.** Capture retargets every later
       * pointer event to the capturing element, and the browser extends a
       * selection by hit-testing where the pointer actually is — so capturing
       * silently disables native drag-select. Under the per-block topology
       * that was invisible, because we drive cross-block selection ourselves;
       * under `singleHostTopology` the browser owns it, and the selection
       * simply stopped at the first block. The window listeners below already
       * carry the gesture past the element's edge, which is the only thing
       * capture was buying here.
       */
      const needsCapture = started.mode !== 'text' || e.pointerType !== 'mouse';
      if (needsCapture) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          /* a detached or non-capturing target: the window listeners still work */
        }
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('blur', onCancel);
      document.addEventListener('keydown', onKey, true);
      return;
    }
  };

  view.content.addEventListener('pointerdown', onDown);
  return () => {
    if (session) finish(false);
    view.content.removeEventListener('pointerdown', onDown);
  };
}
