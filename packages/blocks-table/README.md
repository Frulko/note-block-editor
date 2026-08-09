# @nbe/blocks-table

The simple table as a block plugin: three block types, merged cells,
spreadsheet-style cell selection, column resizing, and both projections.

```ts
import { Editor } from '@nbe/core'
import { EditorView, builtinBlocks } from '@nbe/dom'
import { tableDomBlocks } from '@nbe/blocks-table/dom'

const editor = new Editor()
new EditorView(el, editor, { blocks: [...builtinBlocks, ...tableDomBlocks] })
```

Mounting the view registers the plugins on the model too, so the schema learns
the three types and the table's invariant runs on every transaction.

**Headless** — a CLI, a server, an importer — takes the model half only:

```ts
import { Editor, PluginRegistry } from '@nbe/core'
import { tableBlocks } from '@nbe/blocks-table'

const editor = new Editor({ plugins: tableBlocks })
const plugins = new PluginRegistry().registerAll(tableBlocks)
blocksToMarkdown(blocks, { plugins })      // GFM tables instead of a marker
renderBlocksToHTML(blocks, { plugins })    // real <table> markup
```

A block type is in an output because its plugin is registered. Without it,
nothing crashes and nothing is silently dropped: a table exports as
`<!-- nbe:table -->` and a pasted one degrades to paragraphs.

## What it adds to a document

- `colSpan` / `rowSpan` on cells, with `tableGrid()` as the one place that maps
  cells to slots — once cells can merge, a cell's index in its row is no longer
  its column, and every geometric question routes through it
- `headerRow`, `headerColumn`, `fullWidth`, `columnWidths` on the table
- invariant: every row fills the same number of slots, counting the ones a
  merged neighbour covers (`normalize`, run by the reducer)

## Known losses

GFM has no spans and no column widths: a merged table exports as ragged rows
and comes back unmerged. Declared in `lossyReason`, never silent.
