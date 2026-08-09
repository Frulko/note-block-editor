import { createActionButton, toContainerPoint, type EditorView } from '@nbe/dom';
import { columnCount, insertColumn, insertRow, tableRows } from './model';

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
/** How far outside the table the chrome stays alive — the strips live there. */
const KEEP_ALIVE = 26;

export function attachTableChrome(view: EditorView): () => void {
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
      if (!tableId) return;
      const id = tableId;
      insertColumn(editor, id, columnCount(editor.doc, id));
      // a wide table scrolls, and a column appended out of sight is a column
      // you have to go looking for
      queueMicrotask(() => {
        const table = tableOf(id);
        if (table) table.scrollLeft = table.scrollWidth;
      });
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

    // both strips sit in the margin the table reserves for them (blocks.css),
    // not on top of the block below or on the last column's text
    view.content.append(addRow, addCol);
    addRow.style.left = `${at.x}px`;
    addRow.style.top = `${at.y + rect.height + 3}px`;
    addRow.style.width = `${rect.width}px`;
    addCol.style.left = `${at.x + rect.width + 3}px`;
    addCol.style.top = `${at.y}px`;
    addCol.style.height = `${rect.height}px`;

    // a column border under the pointer grows a resize guide — borders scrolled
    // out of the table's visible box are not grabbable
    resizeColumn = -1;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      firstRowCells(table).forEach((cell, i) => {
        const edge = cell.getBoundingClientRect().right;
        if (edge < rect.left || edge > rect.right) return;
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
    if (table) return place(table, event.clientX, event.clientY);
    /*
     * The strips sit *outside* the table, so the pointer on its way to one is
     * over the page for a few pixels — hiding on the first such event made
     * them unreachable: the button vanished under the cursor before the click.
     * They stay while the pointer is in the band they occupy.
     */
    const current = tableId && tableOf(tableId);
    if (current) {
      const rect = current.getBoundingClientRect();
      const near =
        event.clientX >= rect.left - KEEP_ALIVE &&
        event.clientX <= rect.right + KEEP_ALIVE &&
        event.clientY >= rect.top - KEEP_ALIVE &&
        event.clientY <= rect.bottom + KEEP_ALIVE;
      if (near) return;
    }
    hide();
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
