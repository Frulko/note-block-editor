import type { Block, BlockId } from './types';
import { textCaret } from './types';
import { getBlock, type Doc } from './doc';
import { uuidv7 } from './id';
import type { Editor, Tx } from './editor';

/**
 * Simple table (AQ#3), blocks all the way down:
 *
 *   table       props { headerRow?, columnWidths? }
 *   └ table_row  children = exactly columnCount cells
 *     └ table_cell (inline text, no children in v1 — Notion's restriction)
 *
 * Three block types and NO new operations: a column insert is one transaction
 * of per-row insert_block, a row move is move_block. Everything the editor
 * already owns — undo, duplication, selection, markdown projection, the future
 * CRDT — is inherited rather than rebuilt. A grid stored in props would have
 * forfeited per-cell ids and per-cell history.
 */

export const TABLE_TYPES = ['table', 'table_row', 'table_cell'] as const;

export function isTableType(type: string): boolean {
  return (TABLE_TYPES as readonly string[]).includes(type);
}

export function cellBlock(parentId: BlockId, text = ''): Block {
  return {
    id: uuidv7(),
    type: 'table_cell',
    version: 1,
    props: {},
    text: text ? [{ text }] : [],
    children: [],
    parentId,
  };
}

/** Rows of a table, in order (missing children are tolerated). */
export function tableRows(doc: Doc, tableId: BlockId): Block[] {
  return getBlock(doc, tableId)
    .children.map((id) => doc.blocks.get(id))
    .filter((b): b is Block => b?.type === 'table_row');
}

export function rowCells(doc: Doc, rowId: BlockId): Block[] {
  return getBlock(doc, rowId)
    .children.map((id) => doc.blocks.get(id))
    .filter((b): b is Block => b?.type === 'table_cell');
}

/** Column count, defined by the widest row so a ragged table can be repaired. */
export function columnCount(doc: Doc, tableId: BlockId): number {
  return tableRows(doc, tableId).reduce((n, row) => Math.max(n, rowCells(doc, row.id).length), 0);
}

/** Grid coordinates of a cell, or null when it is not in a table. */
export function cellPosition(doc: Doc, cellId: BlockId): { tableId: BlockId; row: number; column: number } | null {
  const cell = doc.blocks.get(cellId);
  if (cell?.type !== 'table_cell' || !cell.parentId) return null;
  const row = doc.blocks.get(cell.parentId);
  if (row?.type !== 'table_row' || !row.parentId) return null;
  const table = doc.blocks.get(row.parentId);
  if (table?.type !== 'table') return null;
  return {
    tableId: table.id,
    row: tableRows(doc, table.id).findIndex((r) => r.id === row.id),
    column: rowCells(doc, row.id).findIndex((c) => c.id === cellId),
  };
}

export function cellAt(doc: Doc, tableId: BlockId, row: number, column: number): Block | null {
  const rows = tableRows(doc, tableId);
  const target = rows[row];
  if (!target) return null;
  return rowCells(doc, target.id)[column] ?? null;
}

/** Cells in reading order — what Tab walks. */
export function tableCells(doc: Doc, tableId: BlockId): Block[] {
  return tableRows(doc, tableId).flatMap((row) => rowCells(doc, row.id));
}

// ------------------------------------------------------------ construction

export function buildTable(parentId: BlockId | null, rows = 3, columns = 3, headerRow = true): Block[] {
  const table: Block = {
    id: uuidv7(),
    type: 'table',
    version: 1,
    props: { headerRow },
    text: [],
    children: [],
    parentId,
  };
  const out: Block[] = [table];
  for (let r = 0; r < rows; r++) {
    const row: Block = {
      id: uuidv7(),
      type: 'table_row',
      version: 1,
      props: {},
      text: [],
      children: [],
      parentId: table.id,
    };
    table.children.push(row.id);
    out.push(row);
    for (let c = 0; c < columns; c++) {
      const cell = cellBlock(row.id);
      row.children.push(cell.id);
      out.push(cell);
    }
  }
  return out;
}

/** Insert every block of a built subtree, parents first. */
export function insertSubtree(tx: Tx, blocks: Block[], index: number): void {
  const [root, ...rest] = blocks;
  if (!root) return;
  tx.op({ type: 'insert_block', block: root, index });
  for (const block of rest) tx.op({ type: 'insert_block', block, index: 0 });
}

// --------------------------------------------------------------- commands

export function insertTable(editor: Editor, afterBlockId: BlockId, rows = 3, columns = 3): BlockId | null {
  const anchor = getBlock(editor.doc, afterBlockId);
  const blocks = buildTable(anchor.parentId, rows, columns);
  const table = blocks[0]!;
  const parent = getBlock(editor.doc, anchor.parentId ?? editor.doc.rootId);
  const index = parent.children.indexOf(afterBlockId) + 1;
  editor.dispatch((tx) => insertSubtree(tx, blocks, index), {
    origin: 'input',
    selection: textCaret(blocks[2]!.id, 0), // first cell
  });
  return table.id;
}

export function insertRow(editor: Editor, tableId: BlockId, at: number): void {
  const doc = editor.doc;
  const count = columnCount(doc, tableId) || 1;
  const row: Block = {
    id: uuidv7(),
    type: 'table_row',
    version: 1,
    props: {},
    text: [],
    children: [],
    parentId: tableId,
  };
  const cells = Array.from({ length: count }, () => cellBlock(row.id));
  row.children = cells.map((c) => c.id);
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'insert_block', block: row, index: at });
      for (const cell of cells) tx.op({ type: 'insert_block', block: cell, index: 0 });
    },
    { origin: 'input', selection: textCaret(cells[0]!.id, 0) },
  );
}

export function insertColumn(editor: Editor, tableId: BlockId, at: number): void {
  const doc = editor.doc;
  const rows = tableRows(doc, tableId);
  if (!rows.length) return;
  const created: Block[] = [];
  editor.dispatch(
    (tx) => {
      for (const row of rows) {
        const cell = cellBlock(row.id);
        created.push(cell);
        tx.op({ type: 'insert_block', block: cell, index: Math.min(at, row.children.length) });
      }
      const widths = getBlock(doc, tableId).props['columnWidths'];
      if (Array.isArray(widths)) {
        const next = [...widths];
        next.splice(at, 0, 0);
        tx.op({ type: 'update_block', id: tableId, patch: { props: { columnWidths: next } } });
      }
    },
    { origin: 'input', selection: created[0] ? textCaret(created[0].id, 0) : undefined },
  );
}

export function deleteRow(editor: Editor, tableId: BlockId, at: number): void {
  const doc = editor.doc;
  const rows = tableRows(doc, tableId);
  const row = rows[at];
  if (!row) return;
  // the last row would leave an empty table; normalization then dissolves it
  editor.dispatch(
    (tx) => {
      for (const cell of rowCells(doc, row.id)) tx.op({ type: 'delete_block', id: cell.id });
      tx.op({ type: 'delete_block', id: row.id });
    },
    { origin: 'input' },
  );
}

export function deleteColumn(editor: Editor, tableId: BlockId, at: number): void {
  const doc = editor.doc;
  if (columnCount(doc, tableId) <= 1) {
    // removing the only column empties every row: drop the table instead
    deleteTable(editor, tableId);
    return;
  }
  editor.dispatch(
    (tx) => {
      for (const row of tableRows(doc, tableId)) {
        const cell = rowCells(doc, row.id)[at];
        if (cell) tx.op({ type: 'delete_block', id: cell.id });
      }
      const widths = getBlock(doc, tableId).props['columnWidths'];
      if (Array.isArray(widths)) {
        tx.op({
          type: 'update_block',
          id: tableId,
          patch: { props: { columnWidths: widths.filter((_, i) => i !== at) } },
        });
      }
    },
    { origin: 'input' },
  );
}

export function deleteTable(editor: Editor, tableId: BlockId): void {
  const doc = editor.doc;
  editor.dispatch(
    (tx) => {
      for (const row of tableRows(doc, tableId)) {
        for (const cell of rowCells(doc, row.id)) tx.op({ type: 'delete_block', id: cell.id });
        tx.op({ type: 'delete_block', id: row.id });
      }
      tx.op({ type: 'delete_block', id: tableId });
    },
    { origin: 'input' },
  );
}

/** Move a row to a new index (drag reorder). */
export function moveRow(editor: Editor, tableId: BlockId, from: number, to: number): void {
  const rows = tableRows(editor.doc, tableId);
  const row = rows[from];
  if (!row || from === to) return;
  const target = to === 0 ? null : (rows[to > from ? to : to - 1]?.id ?? null);
  editor.dispatch((tx) => tx.op({ type: 'move_block', id: row.id, parentId: tableId, after: target }), {
    origin: 'input',
  });
}

// --------------------------------------------------------- normalization

/**
 * Table invariants, applied by the reducer like the column wrapper GC:
 * every row carries exactly `columnCount` cells, and a table with no rows
 * (or no columns) dissolves rather than lingering as an invisible husk.
 */
export function normalizeTables(doc: Doc, tx: Tx): boolean {
  let changed = false;
  for (const block of [...doc.blocks.values()]) {
    if (block.type !== 'table' || !doc.blocks.has(block.id)) continue;
    const rows = tableRows(doc, block.id);
    const count = columnCount(doc, block.id);

    if (!rows.length || count === 0) {
      for (const row of rows) {
        for (const cell of rowCells(doc, row.id)) tx.op({ type: 'delete_block', id: cell.id });
        tx.op({ type: 'delete_block', id: row.id });
      }
      tx.op({ type: 'delete_block', id: block.id });
      changed = true;
      continue;
    }

    for (const row of rows) {
      const cells = rowCells(doc, row.id);
      for (let i = cells.length; i < count; i++) {
        tx.op({ type: 'insert_block', block: cellBlock(row.id), index: row.children.length });
        changed = true;
      }
    }
  }
  return changed;
}
