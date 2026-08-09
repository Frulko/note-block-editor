import type { EditorView } from './view';
import { findScrollParent } from './ui/drag';

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

/**
 * Put an element on screen — and *only* when it is not already there.
 *
 * @remarks
 * Every edit re-asserts the caret, and re-asserting it used to call
 * `Element.scrollIntoView` unconditionally. That call scrolls **every**
 * scrollable ancestor, not just the one showing the document, so inside a host
 * with its own scrollers — Obsidian's pane, stacked inside a workspace, inside
 * a window — a keystroke could move something far above the editor. That is
 * what "the page scrolls oddly on a reorder" and "stop the re-scroll on Enter"
 * both were.
 *
 * Asking first costs one rect read and removes the whole class: if the target
 * is inside its scrollport, nobody scrolls anything. When it genuinely is off
 * screen the browser's own implementation still does the work, because getting
 * `block: 'nearest'` right across nested scrollers is not worth reimplementing.
 *
 * @category Interaction
 */
export function reveal(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const scroller = findScrollParent(el.parentElement ?? el);
  const paging = scroller === document.scrollingElement || scroller === document.documentElement;
  // the page's own scrollport is the visual viewport, not the documentElement
  // box — which on a phone is the one the keyboard shrinks
  const port = paging
    ? { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight }
    : scroller.getBoundingClientRect();
  if (rect.top >= port.top && rect.bottom <= port.bottom) return;
  el.scrollIntoView({ block: 'nearest' });
}

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

  const revealCaret = () => {
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

  /**
   * True when something has taken part of the screen — a software keyboard.
   *
   * @remarks
   * This guard is what makes the module do what its own comment claims. It
   * listens to `selectionchange` so the caret stays visible *while the
   * keyboard is up*, and without asking whether it is, every programmatic
   * selection change on a desktop was read as "the caret is below the fold,
   * scroll to it". Restoring a caret after a re-render is exactly that — so
   * dragging a block at the top of a long page, with a caret left in the last
   * one, threw the page to the bottom. It took three wrong guesses to find,
   * because the scroll came from the *mobile keyboard guard*.
   */
  const shrunk = (): boolean => viewport.offsetTop + viewport.height < window.innerHeight - 40;

  // the resize lands before the layout settles on some engines; one frame later
  // the caret rect is trustworthy
  const onResize = () => requestAnimationFrame(() => shrunk() && revealCaret());
  viewport.addEventListener('resize', onResize);
  document.addEventListener('selectionchange', onResize);

  return () => {
    viewport.removeEventListener('resize', onResize);
    document.removeEventListener('selectionchange', onResize);
  };
}
