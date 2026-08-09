/**
 * The table's editing behaviour: how it renders, what its menus offer, which
 * keys it owns, and the two features that give it hover chrome and cell
 * selection.
 *
 * This entry depends on `@nbe/dom`; the package's main entry does not. That
 * split is what lets `@nbe/markdown` and `@nbe/static-renderer` consume the
 * same block without ever importing the editor view.
 *
 * @module @nbe/blocks-table/dom
 */
import { format, type DomBlockPlugin, type EditorView } from '@nbe/dom';
import type { BlockId } from '@nbe/core';
import { tableCellPlugin, tablePlugin, tableRowPlugin } from './index';
import {
  cellAt,
  cellPosition,
  cellSpans,
  columnCount,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  insertTable,
  tableCells,
  tableRows,
} from './model';
import { attachTableChrome } from './chrome';
import { attachTableSelect } from './select';
import { tableStyles } from './styles';

/** Narrowest a column may be laid out at; past it the table scrolls. */
export const MIN_COLUMN = 120;

/** Tab through cells. Tabbing past the last one appends a row, so a table can
 * be filled entirely from the keyboard. */
function moveThroughCells(view: EditorView, blockId: BlockId, direction: 1 | -1): boolean {
  const editor = view.editor;
  const position = cellPosition(editor.doc, blockId);
  if (!position) return false;
  const cells = tableCells(editor.doc, position.tableId);
  const index = cells.findIndex((c) => c.id === blockId);
  const next = cells[index + direction];
  if (next) {
    view.focusBlock(next.id, next.text?.length ? Infinity : 0);
    return true;
  }
  if (direction === -1) return true; // at the first cell: stay put, never indent
  insertRow(editor, position.tableId, tableRows(editor.doc, position.tableId).length);
  view.syncDomSelection();
  return true;
}

/** Enter in a cell: down one row, creating it when at the bottom. */
function moveDownCell(view: EditorView, blockId: BlockId): boolean {
  const editor = view.editor;
  const position = cellPosition(editor.doc, blockId);
  if (!position) return false;
  const below = cellAt(editor.doc, position.tableId, position.row + 1, position.column);
  if (below) {
    view.focusBlock(below.id, 0);
    return true;
  }
  insertRow(editor, position.tableId, position.row + 1);
  const created = cellAt(editor.doc, position.tableId, position.row + 1, position.column);
  if (created) view.focusBlock(created.id, 0);
  return true;
}

/**
 * The table, ready to mount.
 *
 * @example
 * ```ts
 * import { tableDomBlocks } from '@nbe/blocks-table/dom'
 * new EditorView(el, editor, { blocks: [...builtinBlocks, ...tableDomBlocks] })
 * ```
 *
 * @category Plugins
 */
export const table: DomBlockPlugin = {
  ...tablePlugin,
  view: {
    styles: tableStyles,
    // chrome that lives outside the block's box, and a pointer gesture that
    // competes with text selection: neither fits a per-block render hook
    features: [
      { name: 'table-chrome', attach: attachTableChrome },
      { name: 'table-select', attach: attachTableSelect },
    ],

    render(ctx, block) {
      const { view, root } = ctx;
      // one CSS grid for the whole table: rows are `display: contents`, so
      // every cell is a grid item and column widths are a single template
      const columns = columnCount(view.editor.doc, block.id) || 1;
      const raw = block.props['columnWidths'];
      const widths =
        Array.isArray(raw) && raw.length === columns && raw.every((w) => typeof w === 'number' && w > 0)
          ? (raw as number[])
          : null;
      // full width (the default) stretches the table across the text column;
      // without it the columns shrink to their content. Either way no column
      // goes under MIN_COLUMN: past that the table overflows and scrolls
      // horizontally instead of squashing every cell to one word per line.
      const fill = block.props['fullWidth'] !== false;
      const tracks = widths
        ? widths.map((w) => `${w}px`)
        : Array.from({ length: columns }, () => `minmax(${MIN_COLUMN}px, ${fill ? '1fr' : 'max-content'})`);
      // with hand-set widths the last column takes the slack, so a full-width
      // table still reaches the right edge
      if (fill && widths) tracks[columns - 1] = `minmax(${widths[columns - 1]}px, 1fr)`;
      root.style.gridTemplateColumns = tracks.join(' ');
      root.classList.toggle('nbe-table-fit', !fill);
      if (block.props['headerColumn'] === true) root.classList.add('nbe-table-header-col');
      if (block.props['headerRow'] !== false) root.classList.add('nbe-table-header');
      for (const childId of block.children) root.append(ctx.child(childId));
      return root;
    },

    toolbarPlacement: 'above',
    toolbar({ block, view, setProps }) {
      const labels = view.labels;
      const props = block.props;
      return [
        {
          icon: 'table',
          title: labels.headerRow,
          active: props['headerRow'] !== false,
          onClick: () => setProps({ headerRow: props['headerRow'] === false }),
        },
        {
          icon: 'columns',
          title: labels.headerColumn,
          active: props['headerColumn'] === true,
          onClick: () => setProps({ headerColumn: props['headerColumn'] !== true }),
        },
        {
          icon: 'move-horizontal',
          title: labels.fullWidth,
          active: props['fullWidth'] !== false,
          // hand-set widths would pin the columns whatever this says, so the
          // toggle drops them: it is the "lay yourself out" button
          onClick: () => setProps({ fullWidth: props['fullWidth'] === false, columnWidths: undefined }),
        },
      ];
    },

    /*
     * Row and column actions act on *the caret's* row, which the hover toolbar
     * has no way to name — so they stay in the ⋮⋮ menu. The live selection is
     * the table itself by the time the menu opens, hence `lastTextCaret`.
     */
    actions(ctx) {
      const labels = ctx.view.labels;
      const editor = ctx.view.editor;
      const caret = ctx.view.lastTextCaret;
      const caretCell = caret ? cellPosition(editor.doc, caret.blockId) : null;
      const position = caretCell?.tableId === ctx.block.id ? caretCell : null;
      const row = position?.row ?? 0;
      const column = position?.column ?? 0;
      return [
        { kind: 'section', label: format(labels.rowN, { n: row + 1 }) },
        { label: labels.insertRowAbove, onSelect: () => insertRow(editor, ctx.block.id, row) },
        { label: labels.insertRowBelow, onSelect: () => insertRow(editor, ctx.block.id, row + 1) },
        { label: labels.deleteRow, onSelect: () => deleteRow(editor, ctx.block.id, row) },
        { kind: 'section', label: format(labels.columnN, { n: column + 1 }) },
        { label: labels.insertColumnLeft, onSelect: () => insertColumn(editor, ctx.block.id, column) },
        { label: labels.insertColumnRight, onSelect: () => insertColumn(editor, ctx.block.id, column + 1) },
        { label: labels.deleteColumn, onSelect: () => deleteColumn(editor, ctx.block.id, column) },
        { kind: 'section', label: labels.table },
        {
          label: labels.headerRow,
          hintIcon: ctx.block.props['headerRow'] !== false ? 'check' : undefined,
          onSelect: () => ctx.setProps({ headerRow: ctx.block.props['headerRow'] === false }),
        },
      ];
    },

    slash: {
      label: 'Tableau',
      keywords: ['table', 'tableau', 'grid', 'grille'],
      icon: 'table',
      // a table is a subtree, not a single block, so it takes its own path
      insert: (view, afterBlockId) => insertTable(view.editor, afterBlockId, 3, 3),
    },
  },
};

/** The row: structure only, rendered as a `display: contents` grid pass-through. */
export const tableRow: DomBlockPlugin = { ...tableRowPlugin, view: {} };

/** The cell: a normal text block, plus the grid spans when it has been merged. */
export const tableCell: DomBlockPlugin = {
  ...tableCellPlugin,
  view: {
    decorate(ctx, block) {
      // rows are `display: contents`, so a merged cell is just a grid item
      // that spans — auto-placement flows the rest around it, as an HTML
      // table would
      const { colSpan, rowSpan } = cellSpans(block);
      if (colSpan > 1) ctx.root.style.gridColumn = `span ${colSpan}`;
      if (rowSpan > 1) ctx.root.style.gridRow = `span ${rowSpan}`;
      if (colSpan > 1 || rowSpan > 1) ctx.root.classList.add('nbe-cell-merged');
    },
    keys: {
      // a cell never splits: Enter moves to the cell below, adding a row at the
      // bottom edge, which is how a table is filled in by typing
      Enter: ({ view, block, event }) => {
        if (event.shiftKey) return false;
        event.preventDefault();
        return moveDownCell(view, block.id);
      },
      // inside a table, Tab walks cells instead of indenting (Notion)
      Tab: ({ view, block, event }) => {
        event.preventDefault();
        return moveThroughCells(view, block.id, event.shiftKey ? -1 : 1);
      },
    },
  },
};

/**
 * The three block types with their editing behaviour, ready to mount.
 *
 * @category Plugins
 */
export const tableDomBlocks: DomBlockPlugin[] = [table, tableRow, tableCell];
