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
 * Asking first costs one rect read and removes half the class: if the target is
 * inside its scrollport, nobody scrolls anything.
 *
 * The other half is *when it genuinely is off screen*, and deferring to
 * `scrollIntoView` there left the original bug intact — a caret below the fold
 * still moved Obsidian's pane, its split and its window along with the
 * document. So the scroll is done by hand, on the one scroller that shows the
 * block: `block: 'nearest'` is two cases, align the top edge or align the
 * bottom one, which is cheaper to write than to keep explaining.
 *
 * @category Interaction
 */
export function reveal(el: HTMLElement, align: RevealAlign = 'nearest'): void {
  const rect = el.getBoundingClientRect();
  const scroller = findScrollParent(el.parentElement ?? el);
  const paging = scroller === document.scrollingElement || scroller === document.documentElement;
  // the page's own scrollport is the visual viewport, not the documentElement
  // box — which on a phone is the one the keyboard shrinks
  const port = paging
    ? { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight }
    : scroller.getBoundingClientRect();
  const visible = rect.top >= port.top && rect.bottom <= port.bottom;
  if (visible && align === 'nearest') return;
  // above the port: bring its top down to the top. Below (or taller than the
  // port, which the first test catches): bring its bottom up to the bottom.
  const top =
    align === 'start'
      ? rect.top - port.top - ANCHOR_MARGIN
      : rect.top < port.top
        ? rect.top - port.top
        : rect.bottom - port.bottom;
  if (!top) return;
  if (paging) window.scrollBy({ top });
  else scroller.scrollTop += top;
  // the editor asked for this one; `holdScroll` must not undo it
  deliberate.set(paging ? (document.scrollingElement ?? document.documentElement) : scroller, Date.now());
}

/**
 * Where a revealed block ends up.
 *
 * @remarks
 * `nearest` is the caret's rule — move as little as possible, and not at all
 * when the block is already on screen. `start` is what *following* something
 * means: a heading reached from the table of contents belongs at the top of
 * the screen with the section under it, and "it was technically visible at the
 * bottom edge" is not arriving anywhere.
 *
 * @category Interaction
 */
export type RevealAlign = 'nearest' | 'start';

/** Breathing room above a block scrolled to the top on purpose. */
const ANCHOR_MARGIN = 12;

/**
 * Scrollers the editor moved on purpose, and when.
 *
 * @remarks
 * A timestamp rather than a position, because what {@link holdScroll} needs to
 * know is "did `reveal` run during the window I am guarding", not "is the
 * scroller where `reveal` left it" — the browser may have adjusted it by a
 * pixel since, and the answer would flip.
 */
const deliberate = new WeakMap<Element, number>();

/**
 * Hold every scroller above `from` where it is, whoever tries to move it.
 *
 * @remarks
 * The editor's own scrolling has been narrowed to `reveal`, which asks first
 * and moves one scrollport — and the page still moves, because the editor is
 * not the only thing on it. A browser scrolls on focus. A host scrolls when a
 * pane's content changes height. Chromium's scroll anchoring picks a different
 * anchor when the DOM above the fold is replaced. None of those are reachable
 * from here, and all of them read to the person typing as "it scrolled by
 * itself".
 *
 * So this guards the *outcome* instead of chasing the causes: the positions
 * are read before an edit, and any that changed are put back after it — except
 * one `reveal` moved during the same window, which is the editor deliberately
 * following the caret.
 *
 * @param from - Any element in the editor; its scrollable ancestors are what
 * gets held.
 * @returns Release, which does the restoring. Call it after the DOM has
 * settled; it also re-checks on the next frame, because a scroll caused by
 * focus can land after the current task.
 */
export function holdScroll(from: Element): () => void {
  const at = Date.now();
  const seen: Array<[Element, number]> = [];
  for (let n: Element | null = from; n; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight) seen.push([n, n.scrollTop]);
  }
  const page = document.scrollingElement;
  if (page && page !== from) seen.push([page, page.scrollTop]);

  const restore = () => {
    for (const [el, was] of seen) {
      // `reveal` moved this one on purpose, during the window being guarded
      if ((deliberate.get(el) ?? -1) >= at) continue;
      if (el.scrollTop !== was) el.scrollTop = was;
    }
  };
  return () => {
    restore();
    // a scroll caused by focus lands after the current task on some engines
    requestAnimationFrame(restore);
  };
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
