import type { EditorView } from './view';
import { modelPointToDom } from './selection';

/**
 * Painting a text selection that spans blocks.
 *
 * @remarks
 * D3 assumed the browser would hold a `Selection` across several editing
 * hosts. Measured in Chromium 150/151: it will not — the selection is clamped
 * to the host it starts in, and every workaround that toggles editability
 * loses the range the moment editability comes back
 * (`e2e/selection-topology.spec.ts`).
 *
 * But a plain **`Range`** spans hosts perfectly well; only `Selection` is
 * constrained. So the fix is to stop asking the browser to *hold* the
 * selection and only ask it to *paint* one, with the CSS Custom Highlight API.
 *
 * Everything else was already in place, which is why this is small:
 * - the model has had cross-block `TextSelection` from the start (§5.2),
 * - every range command goes through `resolveTextRange` in core, so delete,
 *   format and copy were already defined on the model rather than the DOM,
 * - the clipboard serializes from the model too.
 *
 * The honest cost: a highlight is not a selection, so a screen reader does not
 * announce it as one. That is a real accessibility gap, recorded in
 * `docs/TESTING.md`, and it is smaller than the alternative — a permanently
 * editable root re-opens the document-wide reconciler problem D2 exists to
 * avoid, and breaks the input path today (measured: markdown autoformat stops
 * firing under `singleHostTopology`).
 *
 * @category Selection
 */

const HIGHLIGHT_NAME = 'nbe-selection';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistry | null {
  const css = CSS as unknown as { highlights?: HighlightRegistry };
  return typeof Highlight === 'undefined' || !css.highlights ? null : css.highlights;
}

/** True when this browser can paint a cross-block selection. */
export function canPaintCrossBlock(): boolean {
  return registry() !== null;
}

export function attachCrossBlockHighlight(view: EditorView): () => void {
  const highlights = registry();
  if (!highlights) return () => {};

  const clear = () => {
    highlights.delete(HIGHLIGHT_NAME);
    view.content.classList.remove('nbe-crossblock');
  };

  const paint = () => {
    const sel = view.editor.selection;
    if (sel?.kind !== 'text' || sel.anchor.blockId === sel.head.blockId) return clear();

    const from = modelPointToDom(view, sel.anchor);
    const to = modelPointToDom(view, sel.head);
    if (!from || !to) return clear();

    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      // a backwards selection produces an inverted range; swap rather than throw
      if (range.collapsed && (from.node !== to.node || from.offset !== to.offset)) {
        range.setStart(to.node, to.offset);
        range.setEnd(from.node, from.offset);
      }
    } catch {
      return clear(); // a node was replaced between the model and this frame
    }

    highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    // suppresses the native ::selection inside leaves, so the clamped
    // single-block selection the browser still holds is not painted twice
    view.content.classList.add('nbe-crossblock');
  };

  const unsubSelection = view.editor.onSelection(() => paint());
  // a re-render replaces the text nodes the range pointed at
  const unsubChange = view.editor.on(() => paint());
  paint();

  return () => {
    unsubSelection();
    unsubChange();
    clear();
  };
}
