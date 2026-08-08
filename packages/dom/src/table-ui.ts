import { columnCount, insertColumn, insertRow, tableRows } from '@nbe/core';
import { createActionButton } from './ui';
import { toContainerPoint } from './ui/position';
import type { EditorView } from './view';

/**
 * Table hover chrome (Notion): a + strip below to append a row, a + strip on
 * the right to append a column, and a draggable guide on every column border
 * that writes `columnWidths` — the prop `render.ts` already consumes but
 * nothing wrote until now.
 *
 * All three live in `view.content` as absolutely positioned overlays, so they
 * scroll with the table and are re-placed on every pointermove rather than
 * tracking re-renders.
 */

const EDGE_GRAB = 4; // px each side of a column border that grabs the resizer
const MIN_COLUMN = 50;

export function attachTableUI(view: EditorView): () => void {
  const editor = view.editor;

  const tableOf = (id: string): HTMLElement | null =>
    view.content.querySelector(`.nbe-t-table[data-block-id="${id}"]`);

  let tableId: string | null = null;

  const addRow = createActionButton({
    title: view.labels.insertRowBelow,
    icon: 'plus',
    iconSize: 14,
    className: 'nbe-table-add nbe-table-add-row',
    onClick: () => {
      if (tableId) insertRow(editor, tableId, tableRows(editor.doc, tableId).length);
    },
  });
  const addCol = createActionButton({
    title: view.labels.insertColumnRight,
    icon: 'plus',
    iconSize: 14,
    className: 'nbe-table-add nbe-table-add-col',
    onClick: () => {
      if (tableId) insertColumn(editor, tableId, columnCount(editor.doc, tableId));
    },
  });
  const resizer = document.createElement('div');
  resizer.className = 'nbe-table-col-resizer';
  resizer.setAttribute('data-nbe-ui', '');
  for (const el of [addRow, addCol, resizer]) el.setAttribute('contenteditable', 'false');

  let resizeColumn = -1;

  const hide = () => {
    tableId = null;
    addRow.remove();
    addCol.remove();
    resizer.remove();
  };

  /** Cells of the first row: one per column, their edges are the borders. */
  const firstRowCells = (table: HTMLElement): HTMLElement[] =>
    Array.from(table.querySelectorAll<HTMLElement>(':scope > .nbe-t-table_row:first-child > .nbe-t-table_cell'));

  const place = (table: HTMLElement, clientX: number, clientY: number) => {
    tableId = table.dataset['blockId'] ?? null;
    const rect = table.getBoundingClientRect();
    const at = toContainerPoint(view.content, rect.left, rect.top);

    view.content.append(addRow, addCol);
    addRow.style.left = `${at.x}px`;
    addRow.style.top = `${at.y + rect.height + 2}px`;
    addRow.style.width = `${rect.width}px`;
    addCol.style.left = `${at.x + rect.width + 2}px`;
    addCol.style.top = `${at.y}px`;
    addCol.style.height = `${rect.height}px`;

    // a column border under the pointer grows a resize guide
    resizeColumn = -1;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      firstRowCells(table).forEach((cell, i) => {
        const edge = cell.getBoundingClientRect().right;
        if (Math.abs(clientX - edge) <= EDGE_GRAB) resizeColumn = i;
      });
    }
    if (resizeColumn === -1) return resizer.remove();
    const edge = firstRowCells(table)[resizeColumn]!.getBoundingClientRect().right;
    view.content.append(resizer);
    const guide = toContainerPoint(view.content, edge, rect.top);
    resizer.style.left = `${guide.x - resizer.offsetWidth / 2}px`;
    resizer.style.top = `${guide.y}px`;
    resizer.style.height = `${rect.height}px`;
  };

  const onMove = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.nbe-table-add, .nbe-table-col-resizer')) return; // over our own chrome
    const table = target?.closest<HTMLElement>('.nbe-t-table');
    if (!table) return hide();
    place(table, event.clientX, event.clientY);
  };

  resizer.addEventListener('pointerdown', (event) => {
    const table = tableId && tableOf(tableId);
    if (!table || resizeColumn === -1) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('nbe-resizing');
    const column = resizeColumn;
    const startX = event.clientX;
    const widths = firstRowCells(table).map((cell) => cell.getBoundingClientRect().width);
    const start = widths[column]!;

    const onDrag = (e: PointerEvent) => {
      widths[column] = Math.max(MIN_COLUMN, start + (e.clientX - startX));
      table.style.gridTemplateColumns = widths.map((w) => `${w}px`).join(' ');
      const edge = firstRowCells(table)[column]!.getBoundingClientRect().right;
      resizer.style.left = `${toContainerPoint(view.content, edge, 0).x - resizer.offsetWidth / 2}px`;
    };
    const onUp = () => {
      resizer.removeEventListener('pointermove', onDrag);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      resizer.classList.remove('nbe-resizing');
      const id = table.dataset['blockId'];
      if (id)
        editor.dispatch(
          (tx) => tx.op({ type: 'update_block', id, patch: { props: { columnWidths: widths.map(Math.round) } } }),
          { origin: 'ui' },
        );
      hide();
    };
    resizer.addEventListener('pointermove', onDrag);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  });

  view.content.addEventListener('pointermove', onMove);
  view.content.addEventListener('pointerleave', hide);
  return () => {
    view.content.removeEventListener('pointermove', onMove);
    view.content.removeEventListener('pointerleave', hide);
    hide();
  };
}
