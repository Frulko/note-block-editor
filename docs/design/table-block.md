# Design note — simple table block (AQ#3)

Status: **designed, deliberately not implemented** (post-v1 by design; the
research flags tables as historically among the hardest editor features).
This note fixes the model so nothing built meanwhile forecloses it.

## Model: blocks all the way down

```
table            props: { columnWidths?: number[], headerRow?: boolean }
└─ table_row     (children: exactly the table's column count)
   └─ table_cell (inline: true — plain runs, same rich text as paragraphs)
```

Three new block types, zero new persistence machinery: rows and cells are
ordinary blocks with ids, so **selection, ops, undo, duplication, markdown
projection and future CRDT sync are inherited** rather than rebuilt. This is
the same bet as columns (D-columns) and the reason Editor.js-style
"cell grid in props" is rejected: props-embedded grids forfeit per-cell ids,
per-cell history and structured text.

Invariants (schema + reducer normalization, like column GC):
- every `table_row` has exactly `columnCount` cells (derived from the first
  row; enforced on insert/delete column ops)
- `table_cell` children: none in v1 (no nested blocks in cells — Notion's
  simple table has the same restriction)
- an empty table (0 rows) dissolves

## Operations

No new op types. Column insert/delete = one transaction of per-row
`insert_block`/`delete_block` (invertibility free). Row reorder = `move_block`.
`columnWidths` via `update_block`.

## Interactions (the actual hard part)

- **Tab / Shift+Tab**: next/previous cell (creates a row on Tab from the last
  cell, Notion behavior) — overrides indent inside tables.
- **Enter**: moves down a cell (no split in v1); Shift+Enter = newline in cell.
- **Arrow keys**: leaf-boundary interception already generalizes; goal-X
  applies per column.
- **Cell-range selection**: a third selection kind
  `{ kind: 'cells', tableId, anchor: cellId, head: cellId }` rendered as a
  rectangular overlay — the block/text selection state machine already has the
  extension point (tagged union).
- **Clipboard**: copy of a cell range writes TSV in text/plain and
  `<table>` HTML; paste of TSV/`<table>` into a table maps cells, outside a
  table creates one (upgrade of today's row-flattening).
- **Chrome**: row/column handles on hover (reuse `ui/hover` + `ui/menu`),
  drag column resize (reuse `ui/drag`).

## Projections

- Markdown (L1): GFM pipe table when all cells are single-line plain-ish;
  loss list documents alignment and rich marks beyond GFM.
- The existing paste flattening (`row — row — row`) stays as the no-table
  fallback importer.

## Cost estimate & placement

Roughly the size of the columns+selection chunk combined (schema + reducer
invariants ~1 day; interactions and chrome are the bulk). Slot it as its own
milestone **after Phase 2 bindings** — the cell-selection kind and Tab
override are easier to keep coherent once the core API is frozen for
bindings, and no Phase 2 work depends on tables.
