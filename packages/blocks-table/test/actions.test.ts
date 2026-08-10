// @vitest-environment happy-dom
//
// The table's block menu acts on the cell the caret was last in. The live
// selection is the table by the time the menu opens, so this covers the
// lastTextCaret hand-off that makes "Supprimer la ligne" delete the right one.
import { describe, expect, it } from 'vitest';
import { Editor, PluginRegistry, plainText } from '@nbe/core';
import { blockActionEntries, defaultLabels, type EditorView } from '@nbe/dom';
import {
  cellAt,
  cellSpans,
  clearCells,
  deleteColumns,
  deleteRows,
  insertTable,
  mergeCells,
  rowCells,
  tableRows,
} from '../src/model';
import { tableDomBlocks } from '../src/dom';

function setup() {
  const editor = new Editor({ plugins: tableDomBlocks });
  const anchor = {
    id: 'anchor',
    type: 'paragraph',
    version: 1,
    props: {},
    text: [],
    children: [],
    parentId: editor.doc.rootId,
  };
  editor.dispatch((tx) => tx.op({ type: 'insert_block', block: anchor, index: 0 }), { addToHistory: false });
  const tableId = insertTable(editor, 'anchor', 3, 3)!;
  // label every cell so a deleted row/column is identifiable
  tableRows(editor.doc, tableId).forEach((row, r) =>
    rowCells(editor.doc, row.id).forEach((c, col) =>
      editor.dispatch((tx) => tx.op({ type: 'insert_text', id: c.id, offset: 0, runs: [{ text: `${r}${col}` }] }), {
        addToHistory: false,
      }),
    ),
  );
  return { editor, tableId };
}

/**
 * A view stand-in. It carries a real plugin registry because the action
 * dispatch consults one — an empty registry is the honest stand-in for "no
 * plugin owns this type", which is exactly the table's situation.
 */
const viewFor = (editor: Editor, caretBlockId: string | null) =>
  ({
    editor,
    plugins: new PluginRegistry().registerAll(tableDomBlocks),
    labels: defaultLabels,
    lastTextCaret: caretBlockId ? { blockId: caretBlockId, offset: 0 } : null,
  }) as unknown as EditorView;

function entries(editor: Editor, tableId: string, caretBlockId: string | null) {
  return blockActionEntries({
    view: viewFor(editor, caretBlockId),
    ids: [tableId],
    block: editor.doc.blocks.get(tableId)!,
    anchor: document.createElement('div'),
    close: () => {},
  });
}

const labels = (list: ReturnType<typeof entries>) =>
  list.map((e) => ('label' in e ? e.label : '')).filter(Boolean);
const run = (list: ReturnType<typeof entries>, label: string) => {
  // English: the editor's default language, which is what an editor built
  // with no `labels` speaks. Carnet asks for `fr` by name.
  const entry = list.find((e) => 'label' in e && e.label === label);
  (entry as { onSelect: () => void }).onSelect();
};
const grid = (editor: Editor, tableId: string) =>
  tableRows(editor.doc, tableId).map((r) => rowCells(editor.doc, r.id).map((c) => plainText(c.text)));

describe('table block actions', () => {
  it('labels the row and column the caret sits in', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 1, 2)!;
    const list = entries(editor, tableId, cell.id);
    expect(list.some((e) => 'label' in e && e.label === 'Row 2')).toBe(true);
    expect(list.some((e) => 'label' in e && e.label === 'Column 3')).toBe(true);
  });

  it('falls back to the first cell when the caret was never in the table', () => {
    const { editor, tableId } = setup();
    const list = entries(editor, tableId, 'anchor');
    expect(list.some((e) => 'label' in e && e.label === 'Row 1')).toBe(true);
    expect(list.some((e) => 'label' in e && e.label === 'Column 1')).toBe(true);
  });

  it('deletes the row the caret is in, not the first one', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 1, 0)!;
    run(entries(editor, tableId, cell.id), 'Delete row');
    expect(grid(editor, tableId)).toEqual([
      ['00', '01', '02'],
      ['20', '21', '22'],
    ]);
  });

  it('deletes the column the caret is in', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 0, 1)!;
    run(entries(editor, tableId, cell.id), 'Delete column');
    expect(grid(editor, tableId)).toEqual([
      ['00', '02'],
      ['10', '12'],
      ['20', '22'],
    ]);
  });

  it('inserts above and below relative to the caret row', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 1, 0)!;
    run(entries(editor, tableId, cell.id), 'Insert row above');
    expect(grid(editor, tableId).map((r) => r[0])).toEqual(['00', '', '10', '20']);
  });

  it('toggles the header row both ways', () => {
    const { editor, tableId } = setup();
    run(entries(editor, tableId, null), 'Header row');
    expect(editor.doc.blocks.get(tableId)!.props['headerRow']).toBe(false);
    run(entries(editor, tableId, null), 'Header row');
    expect(editor.doc.blocks.get(tableId)!.props['headerRow']).toBe(true);
  });

  it('offers no table actions for a plain paragraph', () => {
    const { editor } = setup();
    const list = blockActionEntries({
      view: viewFor(editor, 'anchor'),
      ids: ['anchor'],
      block: editor.doc.blocks.get('anchor')!,
      anchor: document.createElement('div'),
      close: () => {},
    });
    expect(labels(list).some((l) => /ligne|colonne/i.test(l))).toBe(false);
  });
});

/**
 * Taking rows, columns and contents away.
 *
 * @remarks
 * The single-index versions existed and are what the ⋮⋮ menu uses, on the
 * caret's row. Once a rectangle is selected the thing you mean is the
 * rectangle, and a loop over the single versions gets it wrong twice: one undo
 * per row for one gesture, and — worse — `rowSpan`/`colSpan` are *values*, so
 * two patches on a cell straddling the range each say "one less" and the second
 * silently wins.
 */
describe('deleting a range', () => {
  const texts = (editor: Editor, tableId: string) =>
    tableRows(editor.doc, tableId).map((row) => rowCells(editor.doc, row.id).map((c) => plainText(c.text)));

  it('takes every row in the range, in one undo', () => {
    const { editor, tableId } = setup();
    deleteRows(editor, tableId, 0, 2);
    expect(texts(editor, tableId)).toEqual([['20', '21', '22']]);

    // one gesture, one undo — not two
    editor.undo();
    expect(texts(editor, tableId)).toEqual([
      ['00', '01', '02'],
      ['10', '11', '12'],
      ['20', '21', '22'],
    ]);
  });

  it('takes every column in the range, in one undo', () => {
    const { editor, tableId } = setup();
    deleteColumns(editor, tableId, 0, 2);
    expect(texts(editor, tableId)).toEqual([['02'], ['12'], ['22']]);
    editor.undo();
    expect(texts(editor, tableId)[0]).toEqual(['00', '01', '02']);
  });

  it('shrinks a merged cell by how many of its rows the range took', () => {
    const { editor, tableId } = setup();
    // one cell covering rows 0–2 of the first column
    mergeCells(editor, tableId, { row: 0, column: 0 }, { row: 2, column: 0 });
    expect(cellSpans(cellAt(editor.doc, tableId, 0, 0)!).rowSpan).toBe(3);

    // deleting rows 1 and 2 leaves it covering one row, so it carries no span
    deleteRows(editor, tableId, 1, 2);
    const survivor = cellAt(editor.doc, tableId, 0, 0)!;
    expect(cellSpans(survivor).rowSpan).toBe(1);
    expect(tableRows(editor.doc, tableId)).toHaveLength(1);
  });

  it('shrinks a merged cell by how many of its columns the range took', () => {
    const { editor, tableId } = setup();
    mergeCells(editor, tableId, { row: 0, column: 0 }, { row: 0, column: 2 });
    expect(cellSpans(cellAt(editor.doc, tableId, 0, 0)!).colSpan).toBe(3);

    deleteColumns(editor, tableId, 1, 2);
    expect(cellSpans(cellAt(editor.doc, tableId, 0, 0)!).colSpan).toBe(1);
  });

  it('drops the table when the range is every column', () => {
    const { editor, tableId } = setup();
    deleteColumns(editor, tableId, 0, 3);
    expect(editor.doc.blocks.has(tableId)).toBe(false);
  });

  it('clearing cells empties them and keeps the shape', () => {
    const { editor, tableId } = setup();
    const ids = [cellAt(editor.doc, tableId, 0, 0)!.id, cellAt(editor.doc, tableId, 1, 1)!.id];
    clearCells(editor, ids);

    expect(texts(editor, tableId)).toEqual([
      ['', '01', '02'],
      ['10', '', '12'],
      ['20', '21', '22'],
    ]);
    // the grid is intact: a table with a hole in it is not a table
    expect(tableRows(editor.doc, tableId)).toHaveLength(3);
  });
});
