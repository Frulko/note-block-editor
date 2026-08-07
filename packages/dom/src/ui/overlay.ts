/**
 * The overlay stack: one place that owns "what is open, and what closes it".
 *
 * Before this, every overlay called `dismissable()` and attached its own
 * capture-phase listeners. That made Escape a broadcast — a menu opened from
 * inside a popover closed both — and made an outside-press decision that each
 * overlay took alone, so a nested overlay dismissed its own parent.
 *
 * A stack answers both correctly and cheaply:
 * - Escape closes the TOP entry and stops.
 * - An outside press is judged against the whole stack, then closes every
 *   entry above the deepest one that contains the press.
 *
 * One document listener serves every overlay, regardless of how many are open.
 */

export interface OverlayEntry {
  /** The floating element. Presses inside it are never "outside". */
  el: HTMLElement;
  close: () => void;
  /**
   * Extra nodes that count as inside — a trigger button, or a detached
   * sub-element the overlay owns.
   */
  exempt?: (target: Node) => boolean;
  /** Set false for overlays Escape must not close (rare; a modal step). */
  escape?: boolean;
}

interface StackItem extends OverlayEntry {
  id: number;
}

const stack: StackItem[] = [];
let nextId = 1;
let listening = false;

/** The press that last dismissed something, so a trigger can toggle. */
let lastDismiss: { target: Node; time: number } | null = null;

/**
 * True when the press that just closed an overlay happened inside `trigger`.
 *
 * A trigger button must TOGGLE its overlay: without this, pressing it again
 * dismisses (outside press) and the click that follows immediately reopens,
 * which reads as a broken button. Trigger handlers call this and bail.
 *
 * Still time-bounded, because it genuinely is about one press-then-click pair
 * rather than about state — but the window only has to outlive a single
 * browser-generated click, not a user gesture.
 */
export function dismissedBy(trigger: Node): boolean {
  if (!lastDismiss || Date.now() - lastDismiss.time > 400) return false;
  return trigger === lastDismiss.target || trigger.contains(lastDismiss.target);
}

/** Everything currently open, deepest last. Exposed for the Escape chain. */
export function openOverlays(): readonly OverlayEntry[] {
  return stack;
}

function contains(item: StackItem, target: Node): boolean {
  return item.el.contains(target) || item.exempt?.(target) === true;
}

function onPointerDown(e: Event): void {
  const target = e.target as Node | null;
  if (!target || stack.length === 0) return;
  // find the deepest entry the press landed in; everything above it closes
  let deepest = -1;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (contains(stack[i]!, target)) {
      deepest = i;
      break;
    }
  }
  if (deepest === stack.length - 1) return; // pressed inside the top overlay
  if (deepest === -1) lastDismiss = { target, time: Date.now() };
  // close from the top down; each close() pops its own entry
  for (const item of stack.slice(deepest + 1).reverse()) safeClose(item);
}

/**
 * A control inside an overlay that needs Escape for itself — cancelling an
 * edit rather than closing the overlay — marks itself with this attribute.
 *
 * The stack listens in the capture phase on purpose: an open overlay must beat
 * the editor's keymap, or Escape would drop out of text mode behind an open
 * menu. Capture means nothing deeper ever gets a chance, so the one legitimate
 * exception has to be declared rather than discovered.
 */
export const ESCAPE_SELF_ATTR = 'data-nbe-escape-self';

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // top of the stack only: Escape is "back one level", never "close all"
  const top = stack[stack.length - 1];
  if (!top || top.escape === false) return;
  const target = e.target as Element | null;
  if (target?.closest?.(`[${ESCAPE_SELF_ATTR}]`) && contains(top, target)) return;
  e.preventDefault();
  e.stopPropagation();
  safeClose(top);
}

function onBlur(): void {
  for (const item of [...stack].reverse()) safeClose(item);
}

/** A throwing close() must never strand the rest of the stack. */
function safeClose(item: StackItem): void {
  try {
    item.close();
  } catch (err) {
    console.error('[nbe] overlay close failed', err);
  } finally {
    remove(item.id);
  }
}

function remove(id: number): void {
  const i = stack.findIndex((s) => s.id === id);
  if (i >= 0) stack.splice(i, 1);
  if (stack.length === 0) teardown();
}

function setup(): void {
  if (listening) return;
  listening = true;
  // pointerdown, not click: a press outside must dismiss before the click lands
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur);
}

function teardown(): void {
  if (!listening) return;
  listening = false;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('blur', onBlur);
}

/**
 * Push an overlay onto the stack. The returned function pops it — call it from
 * the overlay's own close path, and it is safe to call twice.
 */
export function pushOverlay(entry: OverlayEntry): () => void {
  const item: StackItem = { ...entry, id: nextId++ };
  stack.push(item);
  setup();
  return () => remove(item.id);
}

/** Close everything. Used when an editor is destroyed under an open overlay. */
export function closeAllOverlays(): void {
  onBlur();
}

/** Test seam: the stack is module state, and tests must start from empty. */
export function __resetOverlays(): void {
  stack.length = 0;
  teardown();
  lastDismiss = null;
}
