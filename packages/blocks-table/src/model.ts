import type { Block, BlockId, Doc, Editor, Tx } from '@nbe/core';
import { getBlock, plainText, textCaret, textLength, uuidv7 } from '@nbe/core';

/**
 * The table's model half: geometry, commands, invariants. No DOM, no
 * markdown — `@nbe/markdown` and `@nbe/static-renderer` consume this without
 * ever loading the editor view.
 *
 * Simple table (AQ#3), blocks all the way down:
 *
 *   table       props { headerRow?, headerColumn?, fullWidth?, columnWidths? }
 *   └ table_row  children = the cells *anchored* in that row
 *     └ table_cell props { colSpan?, rowSpan? } (inline text, no children)
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

/**
 * How many slots a cell covers. Merged cells carry `colSpan`/`rowSpan`; every
 * other cell is 1×1, and a stored 0 or NaN is a corrupt document, not a hole.
 */
export function cellSpans(cell: Block): { colSpan: number; rowSpan: number } {
  const read = (key: string): number => {
    const n = Math.floor(Number(cell.props[key] ?? 1));
    return Number.isFinite(n) && n > 1 ? n : 1;
  };
  return { colSpan: read('colSpan'), rowSpan: read('rowSpan') };
}

/**
 * The table's slot map: `grid[row][column]` holds the id of the cell covering
 * that slot — the same id in every slot a merged cell spans, `null` where a
 * ragged row has nothing.
 *
 * @remarks
 * Once cells can be merged, a cell's index in its row stops being its column:
 * every geometric question (how wide is the table, what is at row 2 column 3,
 * where does an inserted column go) has to be answered here instead. It is the
 * same left-to-right, first-free-slot placement HTML tables use.
 */
export function tableGrid(doc: Doc, tableId: BlockId): (BlockId | null)[][] {
  const rows = tableRows(doc, tableId);
  const grid: (BlockId | null)[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let column = 0;
    for (const cell of rowCells(doc, row.id)) {
      while (grid[r]![column] != null) column++;
      const { colSpan, rowSpan } = cellSpans(cell);
      for (let dr = 0; dr < rowSpan; dr++) {
        // a span reaching past the last row is clamped rather than trusted
        const line = grid[r + dr];
        if (line) for (let dc = 0; dc < colSpan; dc++) line[column + dc] = cell.id;
      }
      column += colSpan;
    }
  });
  const width = grid.reduce((n, line) => Math.max(n, line.length), 0);
  for (const line of grid) for (let c = 0; c < width; c++) if (line[c] == null) line[c] = null;
  return grid;
}

/** Anchor (top-left slot) of every cell of the table, by id. */
function anchors(grid: (BlockId | null)[][]): Map<BlockId, { row: number; column: number }> {
  const out = new Map<BlockId, { row: number; column: number }>();
  grid.forEach((line, row) =>
    line.forEach((id, column) => {
      if (id && !out.has(id)) out.set(id, { row, column });
    }),
  );
  return out;
}

/** Cells of `row` anchored left of `column` — where a new cell goes in its row. */
function anchoredBefore(
  grid: (BlockId | null)[][],
  anchorOf: Map<BlockId, { row: number; column: number }>,
  row: number,
  column: number,
): number {
  const seen = new Set<BlockId>();
  const line = grid[row] ?? [];
  for (let c = 0; c < column; c++) {
    const id = line[c];
    // only cells that start in this row take a slot in its children
    if (id && anchorOf.get(id)?.row === row) seen.add(id);
  }
  return seen.size;
}

/** Column count, defined by the widest row so a ragged table can be repaired. */
export function columnCount(doc: Doc, tableId: BlockId): number {
  return tableGrid(doc, tableId).reduce((n, line) => Math.max(n, line.length), 0);
}

/** Grid coordinates of a cell, or null when it is not in a table. */
export function cellPosition(doc: Doc, cellId: BlockId): { tableId: BlockId; row: number; column: number } | null {
  const cell = doc.blocks.get(cellId);
  if (cell?.type !== 'table_cell' || !cell.parentId) return null;
  const row = doc.blocks.get(cell.parentId);
  if (row?.type !== 'table_row' || !row.parentId) return null;
  const table = doc.blocks.get(row.parentId);
  if (table?.type !== 'table') return null;
  const at = anchors(tableGrid(doc, table.id)).get(cellId);
  return { tableId: table.id, row: at?.row ?? 0, column: at?.column ?? 0 };
}

/** The cell covering a slot — a merged cell answers for every slot it spans. */
export function cellAt(doc: Doc, tableId: BlockId, row: number, column: number): Block | null {
  const id = tableGrid(doc, tableId)[row]?.[column];
  return (id && doc.blocks.get(id)) || null;
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
  const grid = tableGrid(doc, tableId);
  const width = grid.reduce((n, line) => Math.max(n, line.length), 0);
  /*
   * A cell spanning the boundary the new row opens keeps covering it: it grows
   * by one row and the new row is that many cells short. Two consecutive slots
   * holding the same id is exactly what "spans this boundary" means.
   */
  const grow = new Set<BlockId>();
  let covered = 0;
  if (at > 0 && at < grid.length) {
    for (let c = 0; c < width; c++) {
      const id = grid[at - 1]?.[c];
      if (id && id === grid[at]?.[c]) {
        grow.add(id);
        covered++;
      }
    }
  }
  const count = Math.max(width - covered, 0) || 1;
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
      for (const id of grow) {
        const { rowSpan } = cellSpans(getBlock(doc, id));
        tx.op({ type: 'update_block', id, patch: { props: { rowSpan: rowSpan + 1 } } });
      }
    },
    { origin: 'input', selection: textCaret(cells[0]!.id, 0) },
  );
}

export function insertColumn(editor: Editor, tableId: BlockId, at: number): void {
  const doc = editor.doc;
  const rows = tableRows(doc, tableId);
  if (!rows.length) return;
  const grid = tableGrid(doc, tableId);
  const anchorOf = anchors(grid);
  const created: Block[] = [];
  const widen = new Set<BlockId>();
  editor.dispatch(
    (tx) => {
      rows.forEach((row, r) => {
        // a merged cell straddling the boundary widens instead of being split
        const left = at > 0 ? grid[r]?.[at - 1] : null;
        if (left && left === grid[r]?.[at]) return widen.add(left);
        const cell = cellBlock(row.id);
        created.push(cell);
        tx.op({ type: 'insert_block', block: cell, index: anchoredBefore(grid, anchorOf, r, at) });
      });
      for (const id of widen) {
        const { colSpan } = cellSpans(getBlock(doc, id));
        tx.op({ type: 'update_block', id, patch: { props: { colSpan: colSpan + 1 } } });
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

/**
 * Remove `count` rows starting at `at`.
 *
 * @remarks
 * A range rather than a loop over the single-row version, and for two reasons
 * that both bite. One transaction means one undo: deleting the three rows you
 * selected and pressing undo four times is not a thing anyone expects. And a
 * cell reaching in from above loses *one row per deleted row it covers* —
 * `rowSpan` is a value, not a counter, so two separate patches would overwrite
 * each other and the second would undo the first.
 */
export function deleteRows(editor: Editor, tableId: BlockId, at: number, count = 1): void {
  const doc = editor.doc;
  const rows = tableRows(doc, tableId);
  const doomed = rows.slice(at, at + count);
  if (!doomed.length) return;
  const last = at + doomed.length; // exclusive
  const grid = tableGrid(doc, tableId);
  const anchorOf = anchors(grid);

  /*
   * Cells that start above the range and reach into it: each keeps existing and
   * loses however many of its rows fall inside. Counted once, over the whole
   * range, which is the part a loop gets wrong.
   */
  const lost = new Map<BlockId, number>();
  const countedRow = new Set<string>();
  for (let line = at; line < last; line++) {
    for (const id of grid[line] ?? []) {
      if (!id || (anchorOf.get(id)?.row ?? line) >= at) continue;
      /*
       * Once per *row*, keyed by the row and not by the line: a cell that also
       * spans columns appears in the same line several times, and counting
       * those would take rows off it that the range never held.
       */
      const key = `${id}:${line}`;
      if (countedRow.has(key)) continue;
      countedRow.add(key);
      lost.set(id, (lost.get(id) ?? 0) + 1);
    }
  }

  // the last row would leave an empty table; normalization then dissolves it
  editor.dispatch(
    (tx) => {
      for (const row of doomed) {
        for (const cell of rowCells(doc, row.id)) tx.op({ type: 'delete_block', id: cell.id });
        tx.op({ type: 'delete_block', id: row.id });
      }
      for (const [id, rows] of lost) {
        const { rowSpan } = cellSpans(getBlock(doc, id));
        const next = rowSpan - rows;
        tx.op({ type: 'update_block', id, patch: { props: { rowSpan: next > 1 ? next : undefined } } });
      }
    },
    { origin: 'input' },
  );
}

/** One row, which is the range of one. */
export function deleteRow(editor: Editor, tableId: BlockId, at: number): void {
  deleteRows(editor, tableId, at, 1);
}

/**
 * Remove `count` columns starting at `at`.
 *
 * @remarks
 * Same two reasons as {@link deleteRows}: one undo for one gesture, and
 * `colSpan` is a value rather than a counter — a merged cell straddling two
 * deleted columns must lose two, and two independent patches would each say
 * "one less" with the second winning.
 */
export function deleteColumns(editor: Editor, tableId: BlockId, at: number, count = 1): void {
  const doc = editor.doc;
  const total = columnCount(doc, tableId);
  const last = Math.min(total, at + Math.max(1, count)); // exclusive
  if (at >= total) return;
  if (last - at >= total) {
    // removing every column empties every row: drop the table instead
    deleteTable(editor, tableId);
    return;
  }
  const grid = tableGrid(doc, tableId);

  /** How many of the doomed columns each cell occupies. */
  const covered = new Map<BlockId, number>();
  const countedColumn = new Set<string>();
  for (const line of grid) {
    for (let column = at; column < last; column++) {
      const id = line[column];
      if (!id) continue;
      /*
       * Once per *column*, keyed by the column and not by the line: a cell that
       * spans rows appears at the same column on several lines, and a cell that
       * spans columns appears at several columns on one line. Only the second
       * is a column it actually loses.
       */
      const key = `${id}:${column}`;
      if (countedColumn.has(key)) continue;
      countedColumn.add(key);
      covered.set(id, (covered.get(id) ?? 0) + 1);
    }
  }

  editor.dispatch(
    (tx) => {
      for (const [id, columns] of covered) {
        const { colSpan } = cellSpans(getBlock(doc, id));
        const next = colSpan - columns;
        // a merged cell narrows; one that has nothing left goes
        if (next > 0) tx.op({ type: 'update_block', id, patch: { props: { colSpan: next > 1 ? next : undefined } } });
        else tx.op({ type: 'delete_block', id });
      }
      const widths = getBlock(doc, tableId).props['columnWidths'];
      if (Array.isArray(widths)) {
        tx.op({
          type: 'update_block',
          id: tableId,
          patch: { props: { columnWidths: widths.filter((_, i) => i < at || i >= last) } },
        });
      }
    },
    { origin: 'input' },
  );
}

/** One column, which is the range of one. */
export function deleteColumn(editor: Editor, tableId: BlockId, at: number): void {
  deleteColumns(editor, tableId, at, 1);
}

/**
 * Empty the given cells, keeping the shape of the table.
 *
 * @remarks
 * "Delete these cells" cannot mean *remove* them: a grid with a hole in it is
 * not a grid, and every spreadsheet answers this the same way — the cells stay
 * and their contents go. Removing a column or a row is the other thing, and it
 * has its own command.
 */
export function clearCells(editor: Editor, cellIds: readonly BlockId[]): void {
  const doc = editor.doc;
  const withText = cellIds
    .map((id) => doc.blocks.get(id))
    .filter((cell): cell is Block => !!cell && textLength(cell.text) > 0);
  if (!withText.length) return;
  editor.dispatch(
    (tx) => {
      for (const cell of withText) tx.op({ type: 'delete_text', id: cell.id, from: 0, to: textLength(cell.text) });
    },
    { origin: 'input' },
  );
}

// ------------------------------------------------------------ merged cells

export interface CellRect {
  row: number;
  column: number;
  rows: number;
  columns: number;
}

/**
 * The smallest rectangle holding both slots *and* every cell either of them
 * clips — dragging over half of a merged cell selects all of it, as in a
 * spreadsheet. Grows until stable, which it always reaches: it only ever adds.
 */
export function cellRect(doc: Doc, tableId: BlockId, a: Slot, b: Slot): CellRect {
  const grid = tableGrid(doc, tableId);
  const anchorOf = anchors(grid);
  let top = Math.min(a.row, b.row);
  let left = Math.min(a.column, b.column);
  let bottom = Math.max(a.row, b.row);
  let right = Math.max(a.column, b.column);
  for (let pass = 0; pass < 8; pass++) {
    let grown = false;
    for (let r = top; r <= bottom; r++)
      for (let c = left; c <= right; c++) {
        const id = grid[r]?.[c];
        const at = id ? anchorOf.get(id) : undefined;
        if (!id || !at) continue;
        const { colSpan, rowSpan } = cellSpans(getBlock(doc, id));
        if (at.row < top) (top = at.row), (grown = true);
        if (at.column < left) (left = at.column), (grown = true);
        if (at.row + rowSpan - 1 > bottom) (bottom = at.row + rowSpan - 1), (grown = true);
        if (at.column + colSpan - 1 > right) (right = at.column + colSpan - 1), (grown = true);
      }
    if (!grown) break;
  }
  return { row: top, column: left, rows: bottom - top + 1, columns: right - left + 1 };
}

export interface Slot {
  row: number;
  column: number;
}

/**
 * Merge every cell of the rectangle spanned by two slots into the top-left
 * one.
 *
 * @remarks
 * The swallowed cells' text is appended to the survivor rather than dropped:
 * a merge that silently eats what you typed is a merge you undo. Excel warns
 * instead; we keep the words and let the user delete them.
 */
export function mergeCells(editor: Editor, tableId: BlockId, a: Slot, b: Slot): void {
  const doc = editor.doc;
  const rect = cellRect(doc, tableId, a, b);
  if (rect.rows * rect.columns <= 1) return;
  const grid = tableGrid(doc, tableId);
  const anchorId = grid[rect.row]?.[rect.column];
  if (!anchorId) return;
  const anchor = getBlock(doc, anchorId);
  const swallowed: Block[] = [];
  const seen = new Set<BlockId>([anchorId]);
  for (let r = rect.row; r < rect.row + rect.rows; r++)
    for (let c = rect.column; c < rect.column + rect.columns; c++) {
      const id = grid[r]?.[c];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      swallowed.push(getBlock(doc, id));
    }
  if (!swallowed.length && cellSpans(anchor).colSpan === rect.columns && cellSpans(anchor).rowSpan === rect.rows)
    return;
  editor.dispatch(
    (tx) => {
      let offset = plainText(anchor.text).length;
      for (const cell of swallowed) {
        const runs = cell.text ?? [];
        const text = plainText(runs);
        if (text.trim()) {
          const added = offset > 0 ? [{ text: ' ' }, ...runs] : runs;
          tx.op({ type: 'insert_text', id: anchor.id, offset, runs: added });
          offset += text.length + (offset > 0 ? 1 : 0);
        }
        tx.op({ type: 'delete_block', id: cell.id });
      }
      tx.op({
        type: 'update_block',
        id: anchor.id,
        patch: {
          props: {
            colSpan: rect.columns > 1 ? rect.columns : undefined,
            rowSpan: rect.rows > 1 ? rect.rows : undefined,
          },
        },
      });
    },
    { origin: 'input', selection: textCaret(anchor.id, 0) },
  );
}

/** Give a merged cell its slots back, as empty cells. */
export function unmergeCell(editor: Editor, tableId: BlockId, cellId: BlockId): void {
  const doc = editor.doc;
  const cell = doc.blocks.get(cellId);
  if (cell?.type !== 'table_cell') return;
  const { colSpan, rowSpan } = cellSpans(cell);
  if (colSpan === 1 && rowSpan === 1) return;
  const grid = tableGrid(doc, tableId);
  const anchorOf = anchors(grid);
  const at = anchorOf.get(cellId);
  if (!at) return;
  const rows = tableRows(doc, tableId);
  editor.dispatch(
    (tx) => {
      tx.op({ type: 'update_block', id: cellId, patch: { props: { colSpan: undefined, rowSpan: undefined } } });
      for (let dr = 0; dr < rowSpan; dr++) {
        const row = rows[at.row + dr];
        if (!row) continue;
        // left to right, so each insertion shifts the next one by one
        let inserted = 0;
        for (let dc = 0; dc < colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const index = anchoredBefore(grid, anchorOf, at.row + dr, at.column + dc) + inserted;
          tx.op({ type: 'insert_block', block: cellBlock(row.id), index });
          inserted++;
        }
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
    const grid = tableGrid(doc, block.id);
    const count = grid.reduce((n, line) => Math.max(n, line.length), 0);

    if (!rows.length || count === 0) {
      for (const row of rows) {
        for (const cell of rowCells(doc, row.id)) tx.op({ type: 'delete_block', id: cell.id });
        tx.op({ type: 'delete_block', id: row.id });
      }
      tx.op({ type: 'delete_block', id: block.id });
      changed = true;
      continue;
    }

    rows.forEach((row, r) => {
      // slots, not cells: a row under a merged cell is legitimately shorter
      const filled = (grid[r] ?? []).filter((id) => id != null).length;
      for (let i = filled; i < count; i++) {
        tx.op({ type: 'insert_block', block: cellBlock(row.id), index: row.children.length });
        changed = true;
      }
    });
  }
  return changed;
}
