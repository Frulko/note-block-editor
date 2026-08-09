/**
 * The table's own stylesheet, injected once when the plugin is registered.
 *
 * It used to be a slice of `dom/style/blocks.css` and of `chrome.css`. A block
 * that cannot carry its own appearance is not really a plugin, so this file
 * moving out is the test of whether the extraction was real.
 *
 * @module
 */
export const tableStyles = `
/* --- table --- */

.nbe-t-table {
  display: grid;
  /* grid-template-columns comes from render.ts (columnWidths or equal fractions) */
  /* the bottom margin is the strip of page the hover "+ row" button sits in —
     without it the button lands on the block below */
  margin: 4px 0 20px;
  /* the base .nbe-block padding would open a white gutter between the outer
     border and the cells — the "floating chips" look */
  padding: 0;
  /* more columns than fit: the table scrolls on its own instead of pushing the
     page sideways or crushing the cells */
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  border: 1px solid var(--nbe-border-strong);
  border-radius: 0;
  /* cell borders are drawn on the top/left edges only, so the outer border
     stays single-width instead of doubling up */
  border-right: 0;
  border-bottom: 0;
}
/* rows are transparent to the grid: their cells become the grid items */
.nbe-t-table_row {
  display: contents;
}
.nbe-t-table_cell {
  min-width: 0;
  padding: 6px 9px;
  /* undo the base block radius: a cell is a grid tile, not a chip */
  border-radius: 0;
  border-right: 1px solid var(--nbe-border-strong);
  border-bottom: 1px solid var(--nbe-border-strong);
}
.nbe-t-table_cell .nbe-leaf {
  min-height: 1.5em;
}
/* a merged cell is a grid item spanning several tracks (render.ts) */
.nbe-t-table_cell.nbe-cell-merged {
  min-width: 0;
}
/* dragging a cell rectangle: stop the browser extending a text selection under it */
.nbe-t-table.nbe-cell-dragging {
  user-select: none;
  -webkit-user-select: none;
}
/* the selected rectangle — over the header tint, hence the doubled class */
.nbe-t-table_cell.nbe-cell-sel,
.nbe-table-header > .nbe-t-table_row:first-child > .nbe-t-table_cell.nbe-cell-sel {
  background: rgb(var(--nbe-accent-rgb) / 0.16);
}
/* fullWidth off: only as wide as its content, still capped by the text column */
.nbe-t-table.nbe-table-fit {
  width: max-content;
  max-width: 100%;
}
/* the first row is the header when headerRow is on */
.nbe-table-header > .nbe-t-table_row:first-child > .nbe-t-table_cell,
.nbe-table-header-col > .nbe-t-table_row > .nbe-t-table_cell:first-child {
  background: var(--nbe-hover);
  font-weight: 500;
}


.nbe-table-add {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  border: none;
  padding: 0;
  background: var(--nbe-hover);
  color: var(--nbe-text-faint);
  cursor: pointer;
  border-radius: var(--nbe-radius);
  transition: background var(--nbe-fast) var(--nbe-ease), color var(--nbe-fast) var(--nbe-ease);
}
.nbe-table-add-row {
  height: 15px;
}
.nbe-table-add-col {
  width: 15px;
}
.nbe-table-add:hover {
  background: var(--nbe-hover-strong);
  color: var(--nbe-text-muted);
}
.nbe-table-col-resizer {
  position: absolute;
  z-index: 45;
  width: 9px;
  cursor: col-resize;
}
.nbe-table-col-resizer::after {
  content: '';
  display: block;
  margin: 0 auto;
  width: 3px;
  height: 100%;
  background: rgb(var(--nbe-accent-rgb));
  opacity: 0;
  transition: opacity var(--nbe-fast) var(--nbe-ease);
}

.nbe-table-col-resizer:hover::after,
.nbe-table-col-resizer.nbe-resizing::after {
  opacity: 1;
}
`;
