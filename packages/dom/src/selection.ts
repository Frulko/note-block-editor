import type { Point } from '@nbe/core';
import type { EditorView } from './view';

export function leafOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const elNode = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return (elNode?.closest('.nbe-leaf') as HTMLElement) ?? null;
}

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
  // leaf text content maps 1:1 to model plain text (mark spans add no characters)
  return { blockId: leaf.dataset['blockId'], offset: range.toString().length };
}

export function modelPointToDom(view: EditorView, point: Point): { node: Node; offset: number } | null {
  const leaf = view.leafEl(point.blockId);
  if (!leaf) return null;
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  let remaining = point.offset;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = (node.textContent ?? '').length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: leaf, offset: leaf.childNodes.length };
}

/** Keep the model selection in sync with the browser selection. */
export function attachSelectionSync(view: EditorView): () => void {
  const handler = () => {
    if (view.suppressSelectionEvents > 0) {
      view.suppressSelectionEvents--;
      return;
    }
    if (view.composing) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!view.content.contains(sel.anchorNode)) return;
    const anchor = domToModelPoint(sel.anchorNode!, sel.anchorOffset);
    const head = domToModelPoint(sel.focusNode!, sel.focusOffset);
    if (!anchor || !head) return;
    if (anchor.blockId !== head.blockId) {
      // a range crossing leaf boundaries escalates to block selection (D3 / Notion)
      view.editor.setSelection({ kind: 'block', anchor: anchor.blockId, head: head.blockId }, 'dom');
      return;
    }
    view.editor.setSelection({ kind: 'text', anchor, head }, 'dom');
  };
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
