import type { Point } from '@nbe/core';
import { domSelectionIsRemnant } from './caret';
import type { EditorView } from './view';
import { EMPTY_LINE, leafOf } from './topology';

export { leafOf } from './topology';

/** Map a DOM position to a (blockId, offset) model point. */
export function domToModelPoint(node: Node, offset: number): Point | null {
  const leaf = leafOf(node);
  if (!leaf?.dataset['blockId']) return null;
  const range = document.createRange();
  range.selectNodeContents(leaf);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  // leaf text maps 1:1 to model plain text — mark spans add no characters, and
  // the empty-line sentinels are DOM, so they are not counted
  return { blockId: leaf.dataset['blockId'], offset: range.toString().split(EMPTY_LINE).join('').length };
}

/**
 * Select an inline element's own text, so a range command applies to exactly it.
 *
 * @remarks
 * A link is the case: hovering one and pressing "edit", or `⌘K` with the caret
 * merely *inside* one, both mean the whole link and neither has a selection to
 * work from. The hover card had this and the keymap did not, which is why `⌘K`
 * used to need the link selected by hand first.
 *
 * @returns false when the element is not inside a live block.
 *
 * @category Interaction
 */
/** Where an inline element's text sits in its block, in model offsets. */
export function inlineTextRange(
  view: EditorView,
  el: Element,
): { blockId: string; from: number; to: number } | null {
  const leaf = leafOf(el);
  const blockId = leaf?.dataset['blockId'];
  if (!leaf || !blockId || !view.editor.doc.blocks.has(blockId)) return null;
  const before = document.createRange();
  before.selectNodeContents(leaf);
  before.setEnd(el, 0);
  const from = before.toString().length;
  return { blockId, from, to: from + (el.textContent ?? '').length };
}

export function selectInlineText(view: EditorView, el: Element): boolean {
  const at = inlineTextRange(view, el);
  if (!at) return false;
  view.editor.setSelection(
    { kind: 'text', anchor: { blockId: at.blockId, offset: at.from }, head: { blockId: at.blockId, offset: at.to } },
    'keyboard',
  );
  view.syncDomSelection();
  return true;
}

export function modelPointToDom(view: EditorView, point: Point): { node: Node; offset: number } | null {
  const leaf = view.leafEl(point.blockId);
  if (!leaf) return null;
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  let remaining = point.offset;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const text = node.textContent ?? '';
    // a sentinel holds no model character: it is a *place*, and the only place
    // on an empty line the browser will draw a caret at
    if (text === EMPTY_LINE) {
      if (remaining === 0) return { node, offset: 0 };
      continue;
    }
    if (remaining <= text.length) {
      // the end of a line and the start of the empty line under it are the same
      // model offset; aim at the one that can be seen
      if (remaining === text.length && nodes[i + 1]?.textContent === EMPTY_LINE) {
        return { node: nodes[i + 1]!, offset: 0 };
      }
      return { node, offset: remaining };
    }
    remaining -= text.length;
  }
  return { node: leaf, offset: leaf.childNodes.length };
}

/**
 * Keep the model selection in sync with the browser selection. Echo events
 * (from our own programmatic selection writes) resolve to the current model
 * selection and are dropped by equality — no fragile suppression counters.
 */
export function attachSelectionSync(view: EditorView): () => void {
  const handler = () => {
    if (view.composing) return;
    if (view.gesture?.mode === 'block') return; // a block gesture owns the selection
    const sel = document.getSelection();
    // Firefox still ships multi-range selections (bug 753718): only the
    // anchor/focus pair is meaningful, and the spec now caps others at one
    if (!sel || sel.rangeCount === 0) return;
    if (!view.content.contains(sel.anchorNode)) return;
    const anchor = domToModelPoint(sel.anchorNode!, sel.anchorOffset);
    const head = domToModelPoint(sel.focusNode!, sel.focusOffset);
    if (!anchor || !head) return;
    const prev = view.editor.selection;
    /*
     * A block selection has no DOM counterpart, and the browser keeps making
     * its own underneath — a caret dropped on mousedown, a range drag-selected
     * over non-editable content. Neither is intent to leave block mode, and
     * mapping either back is what made a rubber-band selection vanish on
     * release.
     *
     * Leaving block mode is now decided where it happens: the text recognizer
     * clears the block selection when a press lands in editable text. So by
     * the time this runs, a surviving block selection means the user has not
     * asked to leave it.
     */
    if (prev?.kind === 'block') return;
    // the browser's clamped remnant of a painted cross-block selection is not
    // the user's intent, and mapping it back would shrink their selection
    if (domSelectionIsRemnant(view)) return;
    if (
      prev?.kind === 'text' &&
      prev.anchor.blockId === anchor.blockId &&
      prev.anchor.offset === anchor.offset &&
      prev.head.blockId === head.blockId &&
      prev.head.offset === head.offset
    ) {
      return;
    }
    view.editor.setSelection({ kind: 'text', anchor, head }, 'dom');
  };
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
