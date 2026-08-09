import { getBlock, plainText, type BlockId } from '@nbe/core';
import { modelPointToDom, type EditorView } from '@nbe/dom';
import { isLoaded, loadLanguage, tokenize, type TokenGroup } from './highlight';

/**
 * Painting the colours, without touching the DOM.
 *
 * Every other way of highlighting an editable block rewrites the element under
 * the caret on each keystroke, and then spends its remaining code restoring
 * what it broke: the caret, the composition, the reconciler's view of the
 * text. The CSS Custom Highlight API paints `Range`s instead — the leaf keeps
 * exactly the text node it had, and the colours live in a document-level
 * registry that no editor machinery can see.
 *
 * The cost, stated once: `::highlight()` can set colour but not `font-style`
 * or `font-weight`, so comments are not italic and keywords are not bold. And
 * a browser without the API (the same one `canPaintCrossBlock()` gates on)
 * shows plain, perfectly readable code.
 *
 * @module
 */

const GROUPS: TokenGroup[] = [
  'keyword',
  'string',
  'comment',
  'number',
  'name',
  'type',
  'property',
  'operator',
  'meta',
];

const NAME = (group: TokenGroup): string => `nbe-code-${group}`;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistry | null {
  const css = CSS as unknown as { highlights?: HighlightRegistry };
  return typeof Highlight === 'undefined' || !css.highlights ? null : css.highlights;
}

/** True when this browser can paint syntax colours at all. */
export function canPaintCode(): boolean {
  return registry() !== null;
}

export function attachCodeHighlight(view: EditorView): () => void {
  const highlights = registry();
  if (!highlights) return () => {};
  const editor = view.editor;
  /** Ranges per block, so one block's edit does not re-tokenize the document. */
  const byBlock = new Map<BlockId, Map<TokenGroup, Range[]>>();

  const clear = () => {
    for (const group of GROUPS) highlights.delete(NAME(group));
    byBlock.clear();
  };

  /** Push the accumulated ranges into the document's highlight registry. */
  const flush = () => {
    for (const group of GROUPS) {
      const ranges: Range[] = [];
      for (const perBlock of byBlock.values()) ranges.push(...(perBlock.get(group) ?? []));
      if (ranges.length) highlights.set(NAME(group), new Highlight(...ranges));
      else highlights.delete(NAME(group));
    }
  };

  const codeBlocks = (): BlockId[] =>
    [...editor.doc.blocks.values()].filter((b) => b.type === 'code').map((b) => b.id);

  /**
   * Re-tokenize one block and rebuild its ranges.
   *
   * @remarks
   * The ranges are built from *model* offsets through `modelPointToDom`, not
   * by walking text nodes: a code block may hold several runs (a pasted link,
   * an inline mark), and the model is the only place that knows where a
   * character is regardless of how the leaf split it.
   */
  const measure = (id: BlockId) => {
    byBlock.delete(id);
    const block = editor.doc.blocks.get(id);
    if (!block || block.type !== 'code') return;
    const language = String(block.props['language'] ?? 'plain');
    if (!isLoaded(language)) {
      // grammars arrive asynchronously; the repaint follows the import
      void loadLanguage(language).then(() => {
        if (editor.doc.blocks.has(id) && isLoaded(language)) {
          measure(id);
          flush();
        }
      });
      return;
    }
    const code = plainText(block.text);
    const perGroup = new Map<TokenGroup, Range[]>();
    for (const token of tokenize(code, language)) {
      const from = modelPointToDom(view, { blockId: id, offset: token.start });
      const to = modelPointToDom(view, { blockId: id, offset: token.end });
      if (!from || !to) continue;
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        continue; // the leaf was replaced between the model read and this frame
      }
      const list = perGroup.get(token.group);
      if (list) list.push(range);
      else perGroup.set(token.group, [range]);
    }
    if (perGroup.size) byBlock.set(id, perGroup);
  };

  const repaintAll = () => {
    byBlock.clear();
    for (const id of codeBlocks()) measure(id);
    flush();
  };

  /*
   * A re-render replaces the text nodes the ranges pointed at, so this runs
   * after *every* change — but it only re-tokenizes the blocks the change
   * touched, and a document with no code block does nothing at all. Registered
   * after the view's own listener, which is what guarantees the elements exist
   * by the time the ranges are built.
   */
  const unsubscribe = editor.on((change) => {
    const dirty = [...change.dirty].filter((id) => {
      const block = editor.doc.blocks.get(id);
      return block?.type === 'code';
    });
    // a structural change can move or delete blocks the ranges belong to
    const structural = change.ops.some((op) => op.type !== 'insert_text' && op.type !== 'delete_text');
    if (!dirty.length && !structural) return;
    if (structural) return repaintAll();
    for (const id of dirty) measure(id);
    flush();
  });

  // languages already needed by the document, so the first paint is coloured
  for (const id of codeBlocks()) {
    const block = getBlock(editor.doc, id);
    void loadLanguage(String(block.props['language'] ?? 'plain'));
  }
  repaintAll();

  return () => {
    unsubscribe();
    clear();
  };
}
