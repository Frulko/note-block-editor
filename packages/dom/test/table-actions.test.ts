// @vitest-environment happy-dom
//
// The table's block menu acts on the cell the caret was last in. The live
// selection is the table by the time the menu opens, so this covers the
// lastTextCaret hand-off that makes "Supprimer la ligne" delete the right one.
import { describe, expect, it } from 'vitest';
import { Editor } from '@nbe/core';
import { cellAt, insertTable, tableRows, rowCells, plainText } from '@nbe/core';
import { blockActionEntries } from '../src/block-actions';
import type { EditorView } from '../src/view';

function setup() {
  const editor = new Editor();
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

/** A view stand-in: the provider only reads the editor and the last caret. */
const viewFor = (editor: Editor, caretBlockId: string | null) =>
  ({ editor, lastTextCaret: caretBlockId ? { blockId: caretBlockId, offset: 0 } : null }) as unknown as EditorView;

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
    expect(list.some((e) => 'label' in e && e.label === 'Ligne 2')).toBe(true);
    expect(list.some((e) => 'label' in e && e.label === 'Colonne 3')).toBe(true);
  });

  it('falls back to the first cell when the caret was never in the table', () => {
    const { editor, tableId } = setup();
    const list = entries(editor, tableId, 'anchor');
    expect(list.some((e) => 'label' in e && e.label === 'Ligne 1')).toBe(true);
    expect(list.some((e) => 'label' in e && e.label === 'Colonne 1')).toBe(true);
  });

  it('deletes the row the caret is in, not the first one', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 1, 0)!;
    run(entries(editor, tableId, cell.id), 'Supprimer la ligne');
    expect(grid(editor, tableId)).toEqual([
      ['00', '01', '02'],
      ['20', '21', '22'],
    ]);
  });

  it('deletes the column the caret is in', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 0, 1)!;
    run(entries(editor, tableId, cell.id), 'Supprimer la colonne');
    expect(grid(editor, tableId)).toEqual([
      ['00', '02'],
      ['10', '12'],
      ['20', '22'],
    ]);
  });

  it('inserts above and below relative to the caret row', () => {
    const { editor, tableId } = setup();
    const cell = cellAt(editor.doc, tableId, 1, 0)!;
    run(entries(editor, tableId, cell.id), 'Insérer une ligne au-dessus');
    expect(grid(editor, tableId).map((r) => r[0])).toEqual(['00', '', '10', '20']);
  });

  it('toggles the header row both ways', () => {
    const { editor, tableId } = setup();
    run(entries(editor, tableId, null), "Ligne d'en-tête");
    expect(editor.doc.blocks.get(tableId)!.props['headerRow']).toBe(false);
    run(entries(editor, tableId, null), "Ligne d'en-tête");
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
