import type { BlockId } from '@nbe/core';
import {
  createActionButton,
  createMenu,
  format,
  toContainerPoint,
  type EditorView,
  type GestureRecognizer,
} from '@nbe/dom';
import {
  cellAt,
  cellPosition,
  cellRect,
  cellSpans,
  clearCells,
  deleteColumns,
  deleteRows,
  mergeCells,
  tableGrid,
  unmergeCell,
  type CellRect,
} from './model';

/**
 * Cell selection, spreadsheet style: press in a cell, drag across others, and
 * the rectangle they span is selected — then merge it, or split a merged cell
 * back up.
 *
 * Two decisions worth keeping:
 *
 * The selection lives here, not in the model's `Selection`, which knows a text
 * range and a set of blocks and neither of them is a rectangle. It is derived
 * state — two slot coordinates — repainted from the document after every
 * change and dropped when the table changes shape under it.
 *
 * The drag is a {@link GestureRecognizer} inserted ahead of text selection,
 * not another pointerdown listener: one press has one owner (`gestures.ts`).
 * While the pointer stays in the cell it started in, the session does nothing
 * and the browser selects text natively; the rectangle only takes over once
 * the drag leaves that cell, which is precisely where a native selection would
 * have started spanning blocks.
 */

interface Slot {
  row: number;
  column: number;
}

const SELECTED = 'nbe-cell-sel';

export function attachTableSelect(view: EditorView): () => void {
  const editor = view.editor;
  let tableId: BlockId | null = null;
  let from: Slot | null = null;
  let to: Slot | null = null;

  const bar = document.createElement('div');
  bar.className = 'nbe-blocktoolbar nbe-cellbar';
  bar.setAttribute('contenteditable', 'false');
  bar.dataset['nbeUi'] = '';

  const tableEl = (): HTMLElement | null => (tableId ? view.blockEl(tableId) : null);

  const clear = () => {
    for (const el of view.content.querySelectorAll(`.${SELECTED}`)) el.classList.remove(SELECTED);
    tableEl()?.classList.remove('nbe-cell-dragging');
    bar.remove();
    tableId = null;
    from = null;
    to = null;
  };

  /** Every cell the current rectangle covers, whole cells only. */
  const selected = (): { ids: BlockId[]; merged: boolean; rect: CellRect } | null => {
    if (!tableId || !from || !to || !editor.doc.blocks.has(tableId)) return null;
    const rect = cellRect(editor.doc, tableId, from, to);
    const grid = tableGrid(editor.doc, tableId);
    const ids = new Set<BlockId>();
    for (let r = rect.row; r < rect.row + rect.rows; r++)
      for (let c = rect.column; c < rect.column + rect.columns; c++) {
        const id = grid[r]?.[c];
        if (id) ids.add(id);
      }
    const merged = [...ids].some((id) => {
      const cell = editor.doc.blocks.get(id);
      if (!cell) return false;
      const { colSpan, rowSpan } = cellSpans(cell);
      return colSpan > 1 || rowSpan > 1;
    });
    return { ids: [...ids], merged, rect };
  };

  const paint = () => {
    for (const el of view.content.querySelectorAll(`.${SELECTED}`)) el.classList.remove(SELECTED);
    const current = selected();
    if (!current) return bar.remove();

    const boxes: DOMRect[] = [];
    for (const id of current.ids) {
      const el = view.blockEl(id);
      if (!el) continue;
      el.classList.add(SELECTED);
      boxes.push(el.getBoundingClientRect());
    }
    // one plain cell is a caret, not a selection: nothing to offer
    if (!boxes.length || (current.ids.length < 2 && !current.merged)) return bar.remove();

    bar.replaceChildren();
    const button = (title: string, icon: string, onClick: () => void) =>
      createActionButton({
        title,
        icon,
        iconSize: 15,
        className: 'nbe-blocktoolbar-btn',
        preserveSelection: true,
        popover: true,
        onClick,
      });
    if (current.ids.length > 1)
      bar.append(
        button(view.labels.mergeCells, 'cells-merge', () => {
          if (tableId && from && to) mergeCells(editor, tableId, from, to);
          clear();
        }),
      );
    if (current.merged)
      bar.append(
        button(view.labels.unmergeCells, 'cells-split', () => {
          const table = tableId;
          const ids = current.ids;
          clear();
          if (table) for (const id of ids) if (editor.doc.blocks.has(id)) unmergeCell(editor, table, id);
        }),
      );

    /*
     * Taking something away, here rather than only in the ⋮⋮ menu: the menu's
     * versions act on the *caret's* row, which is one row, and by the time you
     * have selected a rectangle the thing you mean is the rectangle.
     *
     * One button opening a menu, not three buttons. Three were tried first and
     * two of them were the same trash icon side by side — "delete rows" and
     * "delete columns" are impossible to tell apart as pictures, and a bar you
     * have to hover to read is a bar that costs more than it saves. A menu also
     * says *how many*, which is the part worth being sure about before pressing.
     *
     * Clearing keeps the shape: a grid with a hole in it is not a grid, so
     * "delete these cells" means their contents, as in every spreadsheet, and
     * removing a row or a column is the other thing.
     */
    const rect = current.rect;
    const ids = current.ids;
    const remove = createActionButton({
      title: view.labels.delete,
      icon: 'trash',
      iconSize: 15,
      className: 'nbe-blocktoolbar-btn',
      preserveSelection: true,
      popover: true,
      onClick: () => {
        const table = tableId;
        const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
        menu.update([
          {
            label: format(view.labels.deleteRowsN, { n: rect.rows }),
            onSelect: () => {
              clear();
              if (table) deleteRows(editor, table, rect.row, rect.rows);
            },
          },
          {
            label: format(view.labels.deleteColumnsN, { n: rect.columns }),
            onSelect: () => {
              clear();
              if (table) deleteColumns(editor, table, rect.column, rect.columns);
            },
          },
          {
            label: view.labels.clearCells,
            onSelect: () => {
              clearCells(editor, ids);
              clear();
            },
          },
        ]);
        menu.open(() => remove.getBoundingClientRect(), { placement: 'bottom-start' });
      },
    });
    bar.append(remove);

    view.content.append(bar);
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    const at = toContainerPoint(view.content, left, top - bar.offsetHeight - 6);
    bar.style.left = `${Math.max(0, at.x)}px`;
    bar.style.top = `${Math.max(0, at.y)}px`;
  };

  const slotOf = (target: Element | null): { tableId: BlockId; slot: Slot } | null => {
    const id = target?.closest<HTMLElement>('.nbe-t-table_cell')?.dataset['blockId'];
    const at = id ? cellPosition(editor.doc, id) : null;
    return at ? { tableId: at.tableId, slot: { row: at.row, column: at.column } } : null;
  };

  const recognizer: GestureRecognizer = {
    name: 'cell-select',
    match: (ctx) => !ctx.onChrome && !!slotOf(ctx.target),
    start(ctx) {
      clear();
      // shift-extend and triple-click are text gestures with their own
      // handling; declining hands the press to the next recognizer
      if (ctx.event.shiftKey || ctx.event.detail >= 3) return null;
      const anchor = slotOf(ctx.target);
      if (!anchor) return null;
      tableId = anchor.tableId;
      from = anchor.slot;
      to = anchor.slot;
      let rectangular = false;
      return {
        mode: 'text',
        move(event) {
          const under = document.elementFromPoint(event.clientX, event.clientY);
          const hit = slotOf(under);
          if (!hit || hit.tableId !== tableId) return;
          if (hit.slot.row === to?.row && hit.slot.column === to?.column) return;
          to = hit.slot;
          if (!rectangular && from!.row === to.row && from!.column === to.column) return;
          /*
           * From here the drag is ours. The browser would be extending a text
           * selection across cells: `user-select: none` on the table stops it
           * growing, and whatever range it already made is dropped.
           */
          rectangular = true;
          event.preventDefault();
          tableEl()?.classList.add('nbe-cell-dragging');
          document.getSelection()?.removeAllRanges();
          editor.setSelection(null, 'dom');
          paint();
        },
        end(committed) {
          tableEl()?.classList.remove('nbe-cell-dragging');
          if (!committed) return clear(); // Escape cancels what was being drawn
          /*
           * A press that never left its cell is a caret placement, not a
           * selection — except on a merged cell, where it is the only way to
           * reach the split button: dragging inside it never leaves the slot.
           */
          if (!rectangular && !selected()?.merged) return clear();
          paint();
        },
      };
    },
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && from) clear();
  };

  /*
   * Dismissal, not arbitration: a press anywhere else drops the rectangle. It
   * observes on `document` for the same reason overlay dismissal does — the
   * press itself belongs to whichever recognizer the router picks.
   */
  const onPress = (event: PointerEvent) => {
    if (!from) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-nbe-ui]')) return; // our own bar
    const hit = slotOf(target);
    if (!hit || hit.tableId !== tableId) clear();
  };

  const before = view.recognizers.findIndex((r) => r.name === 'text-select');
  view.recognizers.splice(before < 0 ? view.recognizers.length : before, 0, recognizer);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onPress, true);
  // a re-render replaces the elements the classes were painted on
  const unsubscribe = editor.on(() => {
    if (!from) return;
    if (!tableId || !editor.doc.blocks.has(tableId) || !cellAt(editor.doc, tableId, from.row, from.column))
      return clear();
    paint();
  });

  return () => {
    const at = view.recognizers.indexOf(recognizer);
    if (at >= 0) view.recognizers.splice(at, 1);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onPress, true);
    unsubscribe();
    clear();
  };
}
