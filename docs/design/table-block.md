# Design note — simple table block (AQ#3)

Status: **shipped 2026-08-06** — the note below was written when it was
deliberately deferred, and was never updated when it landed two days later.
Corrected 2026-08-08.

The model below is the one that shipped, unchanged, which is the useful part of
having written it down first: `table` / `table_row` / `table_cell`, blocks all
the way down, with cells as inline hosts carrying the same runs as a paragraph.
24 tests across `core` and `markdown`.

**What is still deferred**, and was correctly predicted to be the hard part:
cell-range selection, column resize and cell merging. The research flags tables
as historically among the hardest editor features and that remains true of
those three specifically, not of the block model.

**Since 2026-08-09 the table is a plugin**, `@nbe/blocks-table` — not part of
`core` or `dom`. An editor gets tables by registering it:

```ts
import { tableDomBlocks } from '@nbe/blocks-table/dom'
new EditorView(el, editor, { blocks: [...builtinBlocks, ...tableDomBlocks] })
```

and every projection that should keep them needs the same registry
(`blocksToMarkdown(blocks, { plugins })`, `exportVault(ws, { plugins })`), which
is the contract's whole point: a block type is in an output because its plugin
is registered, never by accident. What the extraction forced into the plugin
API is recorded in `docs/design/plugin-refactor-plan.md` (R8).

## Model: blocks all the way down

```
table            props: { columnWidths?: number[], headerRow?: boolean,
                         headerColumn?: boolean, fullWidth?: boolean }
└─ table_row     (children: the cells *anchored* in that row)
   └─ table_cell (inline: true — plain runs, same rich text as paragraphs)
                 props: { colSpan?: number, rowSpan?: number }
```

Three new block types, zero new persistence machinery: rows and cells are
ordinary blocks with ids, so **selection, ops, undo, duplication, markdown
projection and future CRDT sync are inherited** rather than rebuilt. This is
the same bet as columns (D-columns) and the reason Editor.js-style
"cell grid in props" is rejected: props-embedded grids forfeit per-cell ids,
per-cell history and structured text.

Invariants (schema + reducer normalization, like column GC):
- every `table_row` fills exactly `columnCount` *slots* — cells plus the ones
  a merged neighbour covers, so a row under a `rowSpan` is legitimately short.
  `tableGrid()` is the one place that maps cells to slots; once cells can be
  merged, a cell's index in its row is no longer its column, and every
  geometric question (column count, cellAt, where an inserted column goes)
  goes through it
- `table_cell` children: none in v1 (no nested blocks in cells — Notion's
  simple table has the same restriction)
- an empty table (0 rows) dissolves

## Operations

No new op types. Column insert/delete = one transaction of per-row
`insert_block`/`delete_block` (invertibility free). Row reorder = `move_block`.
`columnWidths` via `update_block`.

Merge = delete the swallowed cells (their text is appended to the survivor
rather than dropped) + `update_block` for the spans. Unmerge = the inverse,
`insert_block` per freed slot. A column landing inside a merged cell widens it
instead of splitting it; deleting one of its rows or columns shrinks it.

Markdown has no spans: a merged table exports ragged rows and comes back
unmerged. Known and accepted — the projection is lossy for layout, not for
content.

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
