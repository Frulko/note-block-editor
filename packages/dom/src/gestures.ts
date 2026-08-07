import type { BlockId } from '@nbe/core';
import type { EditorView } from './view';

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

const INTERACTIVE_CHROME =
  '.nbe-checkbox, .nbe-toggle-arrow, .nbe-callout-icon, .nbe-t-link_to_page, .nbe-t-image, [data-nbe-ui], a, button, input, textarea, select';

/**
 * Swallow the click the browser synthesises after a gesture that moved.
 *
 * This is what `justRubberBanded()`'s 300 ms window existed for: a drag that
 * ended over empty space must not also register as "click below the last block
 * to append a paragraph". A one-shot capture listener is the same intent
 * expressed as state — it fires for exactly the next click and then removes
 * itself, so no duration has to be guessed.
 */
function suppressNextClick(): void {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    document.removeEventListener('click', swallow, true);
  };
  document.addEventListener('click', swallow, true);
  // if no click follows (drag ended off-window), drop the listener on the next
  // press rather than leaving it armed for the next real click
  const disarm = () => {
    document.removeEventListener('click', swallow, true);
    document.removeEventListener('pointerdown', disarm, true);
  };
  document.addEventListener('pointerdown', disarm, true);
}

export function attachGestureRouter(
  view: EditorView,
  recognizers: GestureRecognizer[],
): () => void {
  let session: GestureSession | null = null;

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
  };

  const onMove = (e: PointerEvent) => {
    if (!session || !view.gesture) return;
    view.gesture.moved = true;
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

    for (const recognizer of recognizers) {
      if (!recognizer.match(ctx)) continue;
      const started = recognizer.start(ctx);
      if (!started) continue; // declined; the next one may take it
      session = started;
      view.gesture = { name: recognizer.name, mode: started.mode, moved: false };
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
