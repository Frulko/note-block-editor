import { describe, expect, it } from 'vitest';
import { Editor } from '@nbe/core';
import { tableBlocks } from '../src/index';
import { plainText } from '@nbe/core';
import {
  cellAt,
  cellRect,
  cellSpans,
  columnCount,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  insertTable,
  mergeCells,
  rowCells,
  tableGrid,
  tableRows,
  unmergeCell,
} from '../src/model';
import type { Block } from '@nbe/core';

/**
 * Merged cells break the one assumption the rest of the table code made — that
 * a cell's index in its row is its column. `tableGrid` is the answer, and these
 * tests are about everything that has to route through it: the geometry, the
 * merge itself, and the row/column commands that have to step around a span.
 */

function table(rows = 3, columns = 3): { editor: Editor; id: string } {
  const editor = new Editor({ plugins: tableBlocks });
  const anchor: Block = {
    id: 'anchor',
    type: 'paragraph',
    version: 1,
    props: {},
    text: [],
    children: [],
    parentId: editor.doc.rootId,
  };
  editor.dispatch((tx) => tx.op({ type: 'insert_block', block: anchor, index: 0 }), { addToHistory: false });
  const id = insertTable(editor, 'anchor', rows, columns)!;
  tableRows(editor.doc, id).forEach((row, r) =>
    rowCells(editor.doc, row.id).forEach((cell, c) =>
      editor.dispatch((tx) => tx.op({ type: 'insert_text', id: cell.id, offset: 0, runs: [{ text: `${r}${c}` }] }), {
        addToHistory: false,
      }),
    ),
  );
  return { editor, id };
}

/** The slot map as text, one string per row — the shape a reader can check. */
const shape = (editor: Editor, id: string): string[][] =>
  tableGrid(editor.doc, id).map((line) =>
    line.map((cellId) => (cellId ? plainText(editor.doc.blocks.get(cellId)!.text) : '·')),
  );

describe('table geometry with spans', () => {
  it('reports the same geometry as before when nothing is merged', () => {
    const { editor, id } = table();
    expect(columnCount(editor.doc, id)).toBe(3);
    expect(shape(editor, id)).toEqual([
      ['00', '01', '02'],
      ['10', '11', '12'],
      ['20', '21', '22'],
    ]);
  });

  it('repeats a merged cell across every slot it covers', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 1 });
    expect(shape(editor, id)).toEqual([
      ['00 01 10 11', '00 01 10 11', '02'],
      ['00 01 10 11', '00 01 10 11', '12'],
      ['20', '21', '22'],
    ]);
    // and the table is still three columns wide
    expect(columnCount(editor.doc, id)).toBe(3);
    // the swallowed cells are gone from the model, not just hidden
    expect(rowCells(editor.doc, tableRows(editor.doc, id)[1]!.id)).toHaveLength(1);
  });

  it('grows a dragged rectangle to whole cells', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 0, column: 1 });
    // a drag touching only the right half of the merged cell still takes it all
    expect(cellRect(editor.doc, id, { row: 0, column: 1 }, { row: 1, column: 2 })).toEqual({
      row: 0,
      column: 0,
      rows: 2,
      columns: 3,
    });
  });

  it('answers cellAt with the covering cell', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 1 });
    const merged = cellAt(editor.doc, id, 0, 0)!;
    expect(cellAt(editor.doc, id, 1, 1)!.id).toBe(merged.id);
    expect(cellSpans(merged)).toEqual({ colSpan: 2, rowSpan: 2 });
  });

  it('gives the slots back on unmerge', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 1 });
    unmergeCell(editor, id, cellAt(editor.doc, id, 0, 0)!.id);
    expect(shape(editor, id)).toEqual([
      ['00 01 10 11', '', '02'],
      ['', '', '12'],
      ['20', '21', '22'],
    ]);
  });

  it('undoes a merge in one step, text included', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 0, column: 1 });
    editor.undo();
    expect(shape(editor, id)).toEqual([
      ['00', '01', '02'],
      ['10', '11', '12'],
      ['20', '21', '22'],
    ]);
  });
});

describe('row and column commands around a merge', () => {
  it('widens a merged cell when a column lands inside it', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 0, column: 1 });
    insertColumn(editor, id, 1);
    expect(columnCount(editor.doc, id)).toBe(4);
    expect(cellSpans(cellAt(editor.doc, id, 0, 0)!).colSpan).toBe(3);
    expect(shape(editor, id)[1]).toEqual(['10', '', '11', '12']);
  });

  it('inserts beside a merged cell when the column lands on its edge', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 0, column: 1 });
    insertColumn(editor, id, 2);
    expect(cellSpans(cellAt(editor.doc, id, 0, 0)!).colSpan).toBe(2);
    expect(shape(editor, id)[0]).toEqual(['00 01', '00 01', '', '02']);
  });

  it('grows a merged cell when a row lands inside it', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 0 });
    insertRow(editor, id, 1);
    expect(cellSpans(cellAt(editor.doc, id, 0, 0)!).rowSpan).toBe(3);
    // the inserted row is two cells wide, not three: the merge covers the first
    expect(shape(editor, id)[1]).toEqual(['00 10', '', '']);
  });

  it('shrinks a merged cell when one of its rows is deleted', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 0 });
    deleteRow(editor, id, 1);
    expect(cellSpans(cellAt(editor.doc, id, 0, 0)!).rowSpan).toBe(1);
    expect(shape(editor, id)).toEqual([
      ['00 10', '01', '02'],
      ['20', '21', '22'],
    ]);
  });

  it('shrinks a merged cell when one of its columns is deleted', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 0, column: 1 });
    deleteColumn(editor, id, 1);
    expect(cellSpans(cellAt(editor.doc, id, 0, 0)!).colSpan).toBe(1);
    expect(shape(editor, id)).toEqual([
      ['00 01', '02'],
      ['10', '12'],
      ['20', '22'],
    ]);
  });

  it('never pads a short row back to square behind a merge', () => {
    const { editor, id } = table();
    mergeCells(editor, id, { row: 0, column: 0 }, { row: 1, column: 1 });
    // normalization runs on every transaction; a no-op edit must not undo it
    editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props: { headerRow: false } } }));
    expect(rowCells(editor.doc, tableRows(editor.doc, id)[1]!.id)).toHaveLength(1);
  });
});
