import { describe, expect, it } from 'vitest';
import { Editor } from '@nbe/core';
import { tableBlocks } from '../src/index';
import { getBlock } from '@nbe/core';
import { plainText } from '@nbe/core';
import {
  cellAt,
  cellPosition,
  columnCount,
  deleteColumn,
  deleteRow,
  deleteTable,
  insertColumn,
  insertRow,
  insertTable,
  moveRow,
  rowCells,
  tableCells,
  tableRows,
} from '../src/model';
import type { Block } from '@nbe/core';

function seed(editor: Editor): string {
  const b: Block = {
    id: 'anchor',
    type: 'paragraph',
    version: 1,
    props: {},
    text: [{ text: 'avant' }],
    children: [],
    parentId: editor.doc.rootId,
  };
  editor.dispatch((tx) => tx.op({ type: 'insert_block', block: b, index: 0 }), { addToHistory: false });
  return b.id;
}

function grid(editor: Editor, tableId: string): string[][] {
  return tableRows(editor.doc, tableId).map((row) =>
    rowCells(editor.doc, row.id).map((c) => plainText(c.text)),
  );
}

function fill(editor: Editor, tableId: string): void {
  tableRows(editor.doc, tableId).forEach((row, r) =>
    rowCells(editor.doc, row.id).forEach((cell, c) => {
      editor.dispatch(
        (tx) => tx.op({ type: 'insert_text', id: cell.id, offset: 0, runs: [{ text: `${r}${c}` }] }),
        { addToHistory: false },
      );
    }),
  );
}

describe('table construction', () => {
  it('builds a grid of real blocks with ids', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const anchor = seed(editor);
    const tableId = insertTable(editor, anchor, 3, 3)!;
    expect(getBlock(editor.doc, tableId).type).toBe('table');
    expect(tableRows(editor.doc, tableId)).toHaveLength(3);
    expect(columnCount(editor.doc, tableId)).toBe(3);
    expect(tableCells(editor.doc, tableId)).toHaveLength(9);
    // every cell is a first-class block, so it has its own id
    expect(new Set(tableCells(editor.doc, tableId).map((c) => c.id)).size).toBe(9);
    // caret lands in the first cell
    expect(editor.selection).toEqual({
      kind: 'text',
      anchor: { blockId: tableCells(editor.doc, tableId)[0]!.id, offset: 0 },
      head: { blockId: tableCells(editor.doc, tableId)[0]!.id, offset: 0 },
    });
  });

  it('is one undoable step', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const anchor = seed(editor);
    insertTable(editor, anchor, 2, 2);
    editor.undo();
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([anchor]);
    expect([...editor.doc.blocks.values()].filter((b) => b.type.startsWith('table'))).toHaveLength(0);
  });

  it('locates a cell in the grid', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 3, 3)!;
    const target = cellAt(editor.doc, tableId, 1, 2)!;
    expect(cellPosition(editor.doc, target.id)).toEqual({ tableId, row: 1, column: 2 });
    expect(cellPosition(editor.doc, 'anchor')).toBeNull();
  });
});

describe('rows and columns', () => {
  it('inserts a row with the right number of cells', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 3)!;
    insertRow(editor, tableId, 1);
    expect(tableRows(editor.doc, tableId)).toHaveLength(3);
    expect(grid(editor, tableId).map((r) => r.length)).toEqual([3, 3, 3]);
  });

  it('inserts a column into every row at the same index', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 2)!;
    fill(editor, tableId);
    insertColumn(editor, tableId, 1);
    expect(columnCount(editor.doc, tableId)).toBe(3);
    expect(grid(editor, tableId)).toEqual([
      ['00', '', '01'],
      ['10', '', '11'],
    ]);
  });

  it('deletes a row and a column, keeping the grid rectangular', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 3, 3)!;
    fill(editor, tableId);
    deleteRow(editor, tableId, 1);
    expect(grid(editor, tableId)).toEqual([
      ['00', '01', '02'],
      ['20', '21', '22'],
    ]);
    deleteColumn(editor, tableId, 0);
    expect(grid(editor, tableId)).toEqual([
      ['01', '02'],
      ['21', '22'],
    ]);
  });

  it('deleting the last column removes the table rather than leaving empty rows', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 1)!;
    deleteColumn(editor, tableId, 0);
    expect(editor.doc.blocks.has(tableId)).toBe(false);
    expect([...editor.doc.blocks.values()].filter((b) => b.type.startsWith('table'))).toHaveLength(0);
  });

  it('deleting the last row dissolves the table (normalization)', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 1, 2)!;
    deleteRow(editor, tableId, 0);
    expect(editor.doc.blocks.has(tableId)).toBe(false);
  });

  it('column edits round-trip through undo', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 2)!;
    fill(editor, tableId);
    insertColumn(editor, tableId, 0);
    expect(columnCount(editor.doc, tableId)).toBe(3);
    editor.undo();
    expect(columnCount(editor.doc, tableId)).toBe(2);
    expect(grid(editor, tableId)).toEqual([
      ['00', '01'],
      ['10', '11'],
    ]);
  });

  it('moves a row', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 3, 1)!;
    fill(editor, tableId);
    moveRow(editor, tableId, 2, 0);
    expect(grid(editor, tableId)).toEqual([['20'], ['00'], ['10']]);
  });

  it('deleteTable removes the whole subtree', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 2)!;
    deleteTable(editor, tableId);
    expect([...editor.doc.blocks.values()].map((b) => b.type)).toEqual(['page', 'paragraph']);
  });
});

describe('normalization repairs a ragged grid', () => {
  it('pads short rows up to the widest one', () => {
    const editor = new Editor({ plugins: tableBlocks });
    const tableId = insertTable(editor, seed(editor), 2, 2)!;
    // simulate damage: drop one cell from the first row
    const victim = rowCells(editor.doc, tableRows(editor.doc, tableId)[0]!.id)[1]!;
    editor.dispatch((tx) => tx.op({ type: 'delete_block', id: victim.id }), { origin: 'test' });
    // the same transaction's normalization already restored the rectangle
    expect(grid(editor, tableId).map((r) => r.length)).toEqual([2, 2]);
  });
});
