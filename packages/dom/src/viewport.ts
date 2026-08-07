import type { EditorView } from './view';

/**
 * Keeping the caret visible when the virtual keyboard opens.
 *
 * @remarks
 * On a phone the keyboard takes roughly half the screen, and by default the
 * page does not move: the caret can end up behind it, so you are typing into
 * something you cannot see. Nothing in the page's own scroll position changes,
 * which is why this is invisible to every desktop test.
 *
 * `window.innerHeight` does not notice — it reports the *layout* viewport,
 * which the keyboard does not resize. `visualViewport` is the one that shrinks,
 * and it is the only reliable signal that the keyboard is up (there is no
 * keyboard event, and guessing from focus is wrong on a hardware keyboard).
 *
 * The scroll is conditional on purpose. Scrolling on every resize would fight
 * the user during pinch-zoom, which also changes the visual viewport — so this
 * moves only when the caret is actually hidden, and only by enough to show it.
 *
 * @category Interaction
 */

/** Space kept between the caret and the top of the keyboard. */
const MARGIN = 24;

export function attachViewportGuard(view: EditorView): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const caretRect = (): DOMRect | null => {
    const selection = document.getSelection();
    if (!selection?.rangeCount || !view.content.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rects = range.getClientRects();
    if (rects.length) return rects[rects.length - 1]!;
    // a collapsed range in an empty leaf reports no rect; use the leaf itself
    const node = selection.focusNode;
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
    return element?.getBoundingClientRect() ?? null;
  };

  const reveal = () => {
    const caret = caretRect();
    if (!caret) return;
    const bottom = viewport.offsetTop + viewport.height;
    const overflow = caret.bottom + MARGIN - bottom;
    if (overflow <= 0) return; // visible: leave the page where the user put it
    // `scrollBy` on the window, because the caret may be inside a scroller we
    // do not own and the browser resolves that for us
    window.scrollBy({ top: overflow, behavior: 'instant' as ScrollBehavior });
    view.content.closest('[data-nbe-scroller], .page-scroll')?.scrollBy?.({ top: overflow });
  };

  // the resize lands before the layout settles on some engines; one frame later
  // the caret rect is trustworthy
  const onResize = () => requestAnimationFrame(reveal);
  viewport.addEventListener('resize', onResize);
  document.addEventListener('selectionchange', onResize);

  return () => {
    viewport.removeEventListener('resize', onResize);
    document.removeEventListener('selectionchange', onResize);
  };
}
