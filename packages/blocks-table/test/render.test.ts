// @vitest-environment happy-dom
//
// The table's column template is an inline style on the table element, but it
// is computed from the cells of its rows — two blocks apart. Inserting a
// column only dirties the rows, and re-rendering just them left the table laid
// out for the old column count: every extra cell wrapped onto a new grid line
// and the table looked shuffled. That is what these tests pin.
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { builtinBlocks, EditorView } from '@nbe/dom';
import { insertColumn, deleteColumn } from '../src/model';
import { tableDomBlocks } from '../src/dom';

const cell = (id: string, text: string): BlockJSON => ({
  id,
  type: 'table_cell',
  version: 1,
  text: [{ text }],
});

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    {
      id: 'table',
      type: 'table',
      version: 1,
      props: { headerRow: true },
      children: [0, 1].map((r) => ({
        id: `row${r}`,
        type: 'table_row',
        version: 1,
        children: [0, 1, 2].map((c) => cell(`c${r}${c}`, `${r}${c}`)),
      })),
    },
  ],
};

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const editor = new Editor({ doc: docFromJSON(DOC), plugins: tableDomBlocks });
  const view = new EditorView(container, editor, { blocks: [...builtinBlocks, ...tableDomBlocks] });
  const table = () => view.content.querySelector<HTMLElement>('.nbe-t-table')!;
  return {
    editor,
    table,
    /** Tracks in the grid template — one per column, or the table shuffles. */
    tracks: () => table().style.gridTemplateColumns.split(/\s(?![^(]*\))/).length,
    cellsPerRow: () =>
      [...table().children].map((row) => row.querySelectorAll('.nbe-t-table_cell').length),
    destroy: () => {
      view.destroy();
      container.remove();
    },
  };
}

describe('table rendering', () => {
  it('keeps the grid template in step with a column insertion', () => {
    const t = mount();
    expect(t.tracks()).toBe(3);

    insertColumn(t.editor, 'table', 3);
    expect(t.cellsPerRow()).toEqual([4, 4]);
    expect(t.tracks()).toBe(4);

    deleteColumn(t.editor, 'table', 0);
    expect(t.cellsPerRow()).toEqual([3, 3]);
    expect(t.tracks()).toBe(3);
    t.destroy();
  });

  it('lays columns out at a readable width rather than squashing them', () => {
    const t = mount();
    // nine columns cannot fit the text column: they keep their width and the
    // table scrolls (overflow-x in blocks.css) instead of shrinking to fit
    for (let i = 0; i < 6; i++) insertColumn(t.editor, 'table', 3 + i);
    expect(t.tracks()).toBe(9);
    expect(t.table().style.gridTemplateColumns).toContain('minmax(120px, 1fr)');
    t.destroy();
  });

  it('sizes to its content when full width is off', () => {
    const t = mount();
    t.editor.dispatch((tx) => tx.op({ type: 'update_block', id: 'table', patch: { props: { fullWidth: false } } }));
    expect(t.table().classList.contains('nbe-table-fit')).toBe(true);
    expect(t.table().style.gridTemplateColumns).toContain('max-content');
    t.destroy();
  });

  it('marks the first column as a header on demand', () => {
    const t = mount();
    t.editor.dispatch((tx) => tx.op({ type: 'update_block', id: 'table', patch: { props: { headerColumn: true } } }));
    expect(t.table().classList.contains('nbe-table-header-col')).toBe(true);
    t.destroy();
  });
});
