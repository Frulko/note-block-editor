import { getBlock } from '@nbe/core';
import type { EditorFeature } from './features';
import type { GestureRecognizer } from './gestures';

/**
 * Drag the edge of an image or an embed to size it.
 *
 * @remarks
 * Presets got most of the way: 50 / 75 / 100 covers "smaller", "bigger" and
 * "full width", which is what a menu is good at. What a menu cannot do is the
 * last ten percent — the figure that has to sit exactly beside a paragraph, or
 * the video that has to stop just short of the margin — and that is a
 * direct-manipulation problem, not a list problem.
 *
 * Two handles, one per side, because the side you grab decides what the drag
 * *means*: on a left-aligned image the right edge is the one that moves, on a
 * right-aligned one it is the left, and on a centred one both edges move at
 * once and the width changes twice as fast as the pointer. Guessing from a
 * single handle would be wrong on two of the three.
 *
 * The handles live in the block's own markup rather than in an overlay: they
 * are `contenteditable="false"` and marked `data-nbe-ui`, so the gesture
 * router already treats them as chrome, and a re-render keeps them instead of
 * having to re-place a floating layer. The feature only wires the drag, by
 * delegation.
 *
 * @category Interaction
 */

/** The narrowest a media block may get, in percent of the text column. */
const MIN = 10;

/** The shortest a framed surface may get, in CSS pixels. */
const MIN_HEIGHT = 80;

/**
 * Build the handles a resizable surface carries.
 *
 * @param options - `vertical` adds a third handle on the bottom edge.
 *
 * @remarks
 * An image has one dimension worth dragging: its width, because its height
 * follows from the picture. A frame has two — nothing inside it tells the page
 * how tall the thing being framed wants to be — so a frame asks for the bottom
 * one and gets a height in pixels, where width stays a percentage of the text
 * column.
 *
 * @category Interaction
 */
export function resizeHandles(options: { vertical?: boolean } = {}): HTMLElement[] {
  const sides = options.vertical ? (['left', 'right', 'bottom'] as const) : (['left', 'right'] as const);
  return sides.map((side) => {
    const handle = document.createElement('span');
    handle.className = `nbe-media-handle nbe-media-handle-${side}`;
    handle.dataset['nbeUi'] = '';
    handle.dataset['side'] = side;
    handle.setAttribute('contenteditable', 'false');
    handle.setAttribute('aria-hidden', 'true');
    return handle;
  });
}

/**
 * Fill the screen with one element — the lightbox, spelled the platform's way.
 *
 * @param host - The block element; the first `[data-nbe-fullscreen]` inside it
 * is what goes up, or the element itself when it carries nothing marked.
 *
 * @remarks
 * `requestFullscreen` *is* the feature. The browser paints the backdrop, traps
 * focus, takes Escape and puts the page back exactly as it was. Hand-building
 * that picture means a fixed layer, a scroll lock, a focus trap and an Escape
 * handler kept in step with the overlay stack — four things to get wrong for
 * the same result.
 *
 * A refusal is swallowed: a host that forbids it leaves the frame where it is,
 * which is a button that did nothing rather than an unhandled rejection in a
 * vault's console.
 *
 * @category Interaction
 */
export function requestFullscreen(host: HTMLElement | null | undefined): void {
  const el = host?.querySelector<HTMLElement>('[data-nbe-fullscreen]') ?? host;
  void el?.requestFullscreen?.().catch(() => {});
}

export const mediaResizeFeature: EditorFeature = {
  name: 'media-resize',
  attach(view) {
    /*
     * A recognizer, not a listener of its own. The gesture router already owns
     * window-level moves, Escape, blur, pointercancel, exception safety and
     * teardown; a second drag implementation beside it is four ways to leave
     * the page in gesture state. `unshift` because a handle sits on top of an
     * image, and the image's own drag would otherwise take the press first.
     */
    const recognizer: GestureRecognizer = {
      name: 'media-resize',
      match: (ctx) => !!ctx.target.closest?.('.nbe-media-handle'),
      start(ctx) {
        const handle = ctx.target.closest<HTMLElement>('.nbe-media-handle')!;
        const target = handle.closest<HTMLElement>('[data-nbe-resizable]');
        const blockEl = handle.closest<HTMLElement>('.nbe-block');
        const id = blockEl?.dataset['blockId'];
        const track = target?.parentElement;
        if (!target || !track || !id || !view.editor.doc.blocks.has(id)) return null;
        const full = track.getBoundingClientRect().width;
        if (full <= 0) return null;

        ctx.event.preventDefault();

        /*
         * The bottom edge is the other dimension, and it is a different unit.
         *
         * Width is a share of the text column, which is what makes a figure
         * keep its proportion when the column narrows. Height has nothing to be
         * a share *of* — a frame is as tall as what is inside it needs, which
         * the page cannot know — so it is pixels, the same number the preset
         * cycle in the toolbar writes.
         */
        if (handle.dataset['side'] === 'bottom') {
          const props = getBlock(view.editor.doc, id).props;
          // no prop yet means the box is coming from a provider ratio or a
          // default; the measured height is where the drag has to start, or the
          // first pixel of movement jumps
          const was = Number(props['height'] ?? 0) || Math.round(target.getBoundingClientRect().height);
          const wasStyle = target.style.height;
          const originY = ctx.event.clientY;
          let height = was;
          view.content.classList.add('nbe-media-resizing', 'nbe-media-resizing-y');

          return {
            mode: 'block',
            move(e) {
              height = Math.max(MIN_HEIGHT, Math.round(was + (e.clientY - originY)));
              target.style.height = `${height}px`;
            },
            end(committed) {
              view.content.classList.remove('nbe-media-resizing', 'nbe-media-resizing-y');
              if (!committed || height === was) {
                target.style.height = wasStyle;
                return;
              }
              view.editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { height } } }), {
                origin: 'ui',
              });
            },
          };
        }
        // a centred surface moves both edges, so it widens twice as fast as the
        // pointer; an aligned one only moves the edge being dragged
        const centred = blockEl!.classList.contains('nbe-align-center');
        const grows = handle.dataset['side'] === 'right' ? 1 : -1;
        const origin = ctx.event.clientX;
        /*
         * The starting width is the *prop*, not the measured box. A figure at
         * `width: 100%` measures 99-point-something of its parent once padding
         * and a border are in it, so measuring would shave a percent off on
         * every drag — and put one on an abandoned one, which is a document
         * changed by a gesture that was cancelled.
         */
        const was = Math.min(100, Math.max(MIN, Number(getBlock(view.editor.doc, id).props['width'] ?? 100)));
        const wasStyle = target.style.width;
        let width = was;
        view.content.classList.add('nbe-media-resizing');

        return {
          mode: 'block',
          move(e) {
            const delta = ((e.clientX - origin) * grows * (centred ? 2 : 1) * 100) / full;
            width = Math.min(100, Math.max(MIN, Math.round(was + delta)));
            target.style.width = `${width}%`;
          },
          end(committed) {
            view.content.classList.remove('nbe-media-resizing');
            if (!committed || width === was) {
              // an abandoned drag leaves no trace: the inline width is ours
              // until a transaction makes it the document's
              target.style.width = wasStyle;
              return;
            }
            view.editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { width } } }), {
              origin: 'ui',
            });
          },
        };
      },
    };
    view.recognizers.unshift(recognizer);
    return () => {
      const at = view.recognizers.indexOf(recognizer);
      if (at >= 0) view.recognizers.splice(at, 1);
    };
  },
};
