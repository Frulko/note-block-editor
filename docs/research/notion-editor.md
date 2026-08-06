# How Notion's Editor Actually Works — Data Model and UX

Research note, August 2026. Primary sources: Notion's engineering blog, the public API reference, reverse-engineered clients of the private API, help-center docs, and third-party post-mortems.

## TL;DR

- **Everything is a block**: one uniform record `{id, type, properties, content[], parent}` for text, images, database rows, and pages themselves. `content` is an ordered array of child block IDs (render tree); `parent` is a separate upward pointer used *only* for permission inheritance — the two mirror each other but serve different jobs.
- **Indentation is structural, not styling**: indenting a block moves it into the previous sibling's `content` array. The document is a tree of records, not a string with markup.
- **"Turn into" is trivial by design**: changing a block's `type` never touches `properties` or `content`; unused properties are simply ignored by the new renderer (a to-do's `checked` survives a round-trip through heading).
- **Inline rich text is a flat array of segments**, each `[text, [attribute-list]]` internally (`"b"`, `"i"`, `"a"+url`, `"u"+user_id`, `"p"+page_id`, `"d"+date, "h"+color, "m"+comment_id`) — surfaced in the public API as `rich_text[]` objects with an `annotations` map. No nested mark tree, no HTML.
- **Columns are just blocks**: a `column_list` block whose children are `column` blocks (each with optional `width_ratio`), whose children are ordinary blocks. Layout lives in the same tree as content.
- **Databases are blocks too**: an internal `collection` holds the schema, `collection_view` blocks hold filter/sort/layout, and every row is a full page block parented under the collection. Since 2025, a "database" is a container of one or more *data sources*, each with its own schema.
- **Sync is operation-based**: client-generated UUIDs, optimistic local apply, transactions of small operations POSTed to `/saveTransactions`, fan-out over WebSocket via MessageStore, local `RecordCache` (SQLite native / IndexedDB→WASM-SQLite web).
- **The UX moat is a small set of patterns**: slash menu, hover `+`/`⋮⋮` controls, Escape-to-block-selection, blue drop guides that create columns, markdown autoformat on type, "Type '/' for commands" placeholder, side peek.
- **The known failures are instructive**: no real offline until August 2025, cross-block *text* selection only shipped in 2022 (per-block contentEditable made it hard), large pages and rollup-heavy databases are slow, and Markdown export is lossy (columns, toggles, callouts, colors, synced blocks, databases-as-CSV).

## Findings

### 1. The block: Notion's single universal record

From [The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion): "Everything you see in Notion is a block. Text, images, lists, a row in a database, even pages themselves." Every block has:

- **`id`** — UUID v4, *generated client-side* at creation (this is what makes optimistic offline creation possible; page IDs are visible at the end of page URLs).
- **`type`** — how the block renders and how its properties are interpreted.
- **`properties`** — a bag of type-specific data. Nearly every block has `title` (the rich text). Database row pages carry user-defined fields here too.
- **`content`** — an *ordered array of child block IDs*. This is the render tree: bullet children, toggle contents, a page's body.
- **`parent`** — the parent block ID, used **exclusively for permission inheritance**.

The reverse-engineered private API ([kjk/notionapi block.go](https://github.com/kjk/notionapi/blob/master/block.go)) shows the full internal record also carries `parent_table` (blocks can be parented by a block, a space, or a collection), `format` (per-block presentation data: page icon, cover, block color, column ratio), `alive` (soft-delete flag — deletion is un-linking + `alive=false`, which is what powers Trash/restore), `version`, and created/edited metadata. Internal type names differ from the public API: `text`, `header`/`sub_header`/`sub_sub_header`, `bulleted_list`, `collection_view`, `collection_view_page`, `column_list`, `column`, `alias` (link-to-page), and `transclusion_container`/`transclusion_reference` (synced blocks).

**Pages are blocks** with special rendering: "Page blocks display their content in a new page, instead of rendering it indented in the current page." A sub-page is literally a `page` block sitting in its parent page's `content` array. This single decision unifies page tree, sidebar, nesting, and moving pages — moving a page is a splice of one ID between two `content` arrays.

**Indentation is structure.** "In Notion, indentation is structural: it's a reflection of the structure of the render tree… when you indent something in Notion, you are manipulating relationships between blocks and their content, not just adding a style." Tab moves the block into the preceding sibling's `content`.

**Two pointer systems, deliberately redundant.** `content` arrays are downward pointers for rendering; `parent` is an upward pointer for permissions. The blog is explicit about why: because a block ID can appear in more than one place (the structure is a directed graph, not a strict tree), walking `content` arrays upward would be ambiguous *and* slow — "the upward parent pointers, and the downward content pointers mirror each other (outside of a few edge cases we're working to clean up)." Permissions attach to blocks and are resolved by walking `parent` up to the workspace root. This also matters at the storage layer: Notion shards Postgres **by workspace ID** so a whole tree lives on one shard — 480 logical shards across 32→96 physical machines, chosen because the block table "reflects trees of user-created content that can vary wildly in size, depth, and branching factor" ([Herding elephants: sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion), [HowWorks: How Notion Was Built](https://howworks.ai/blog/how-notion-was-built)).

**Type transformation without data loss.** "Changing the type of a block doesn't change the block's properties or content — it only changes the type attribute. The information is just rendered differently, or even ignored if the property isn't used by that block type." A checked to-do turned into a heading and back is still checked. This is why "Turn into" can offer *every* block type unconditionally.

**Block lifecycle / sync pipeline** (from the same post + [HowWorks](https://howworks.ai/blog/how-notion-was-built)):
1. Client generates the ID, creates the record, splices it into the parent's `content` — all locally and optimistically.
2. Edits are **operations** batched into **transactions** (pressing Enter in a to-do = ~3 operations in one transaction).
3. Records are cached in **RecordCache** (LRU; SQLite on native, IndexedDB then WASM SQLite on web); pending transactions buffer in a **TransactionQueue** so edits survive restarts offline.
4. Transactions POST to `/saveTransactions`; the server loads affected blocks, validates permissions and coherency, commits, and notifies **MessageStore**.
5. MessageStore fans out over WebSocket to subscribed clients, which call `syncRecordValues` to refresh their caches and re-render.
6. Page loads use `loadPageChunk`, descending the content tree from a root block and returning blocks plus every record needed to render — inherently slower for deep/large trees.

### 2. Columns: layout inside the block tree

Columns are not a property of the page; they are two nested block types ([Notion API block reference](https://developers.notion.com/reference/block)):

- **`column_list`** — an empty-payload container whose children may *only* be `column` blocks; must contain ≥ 2 columns.
- **`column`** — carries an optional `width_ratio` (0–1, ratios across the list should sum to 1; omitted = equal widths); must contain ≥ 1 child; accepts any block type *except another column* (internally the `format` on the column block stores the ratio).

UX for creating/destroying them is entirely drag-based ([Columns, headings & dividers](https://www.notion.com/help/columns-headings-and-dividers)): drag a block by `⋮⋮` toward another block's left/right edge and "follow the blue guides"; a vertical blue guide = drop creates/extends a column list. Resizing: hover the shared edge, drag the gray vertical guide. Removing: drag the content back until "the blue guide span[s] the width of the page" — the empty `column`/`column_list` wrappers dissolve automatically. On mobile, columns flatten to stacked full-width content (an accepted responsive degradation, not an error).

Design lesson: modeling layout as ordinary blocks means drag-drop, undo, permissions, selection and sync all work on columns for free — but it also creates *wrapper garbage collection* obligations (auto-delete a `column_list` when one column remains; unwrap a `column` when empty).

### 3. Inline rich text: flat segments with annotation lists

**Internal format** (verified in [kjk/notionapi inline_block.go](https://github.com/kjk/notionapi)): a block's `properties.title` is an array of segments, each `["text", [[attr, arg?]...]]`:

- `["b"]` bold, `["i"]` italic, `["s"]` strikethrough, `["c"]` inline code
- `["a", url]` link
- `["h", color]` text/background color
- `["u", user_id]` user mention, `["p", page_id]` page mention, `["d", {date-json}]` date mention
- `["m", comment_id]` comment anchor — **comments are an annotation on a text range**, not a separate span tree
- inline equations are a segment whose attr carries the KaTeX expression (the segment text is a placeholder character)

So `Hello **world**` is `[["Hello "], ["world", [["b"]]]]`. There is **no nesting of marks** — a segment simply lists every attribute active on it. Overlapping formatting is resolved by splitting into more segments. This is dramatically simpler than HTML/DOM trees or ProseMirror mark sets with ordering rules, and it serializes/diffs cleanly.

**Public API surface** ([Rich text reference](https://developers.notion.com/reference/rich-text)): each `rich_text[]` element is `{type: "text"|"mention"|"equation", <type payload>, annotations: {bold, italic, strikethrough, underline, code, color}, plain_text, href}`. Colors are an enum of 9 hues + `_background` variants. Mention subtypes: `user`, `page`, `database`, `date` (start/end), `link_preview`, `template_mention` (dynamic `today`/`now`/`me` values inside templates), plus custom emoji. `plain_text` being precomputed on every span is a deliberate kindness to consumers (exporters don't need to understand every payload).

Consequence worth internalizing: because text lives *per block* as a small flat array, there is no globally-addressable character offset in a Notion document. Cross-block operations (multi-block selection, find-and-replace, CRDT merge) operate on (block id, segment offset) coordinates.

### 4. Page links, backlinks, mentions, synced blocks

**Three distinct link constructs:**
1. **Sub-page** — a `page` block physically in the parent's `content` (public API: `child_page`). One canonical location.
2. **Link to page** — internal `alias` type, public `link_to_page`: a block that *points at* a page living elsewhere. Renders like a page row but has no children of its own.
3. **Inline page mention** — a `["p", page_id]` rich-text segment created via `@Page`, `[[Page` or `+Page` ([Links & backlinks help](https://www.notion.com/help/create-links-and-backlinks)). Mentions render the live page title (rename-safe — the title is resolved at render time from the referenced record, never copied).

**Backlinks are derived, not authored**: every page mention automatically produces a backlink entry on the target page, shown as an "N backlinks" affordance under the title. Users never manage them. Implementation-wise this is an index over mentions/links (target_page_id → referencing blocks) maintained by the backend; the editor only needs to *create mentions*, and the backlink panel is a query.

**Synced blocks = transclusion** ([Designing Synced Blocks](https://www.notion.com/blog/designing-synced-blocks)). Explicitly inspired by Ted Nelson: "Transclusion means that part of one thing is included in another and brought from the original." Model: an **original** container owns the children; **references** point at it. Internal types `transclusion_container`/`transclusion_reference`; public API `synced_block` with `synced_from: null` (original) vs `synced_from: {block_id}` (reference) — the API refuses to update synced content through references ([API block reference](https://developers.notion.com/reference/block)). Two UX findings from their design write-up worth stealing:
- Creation is **copy/paste**, not a new concept: paste a synced block elsewhere and it stays synced. Familiar verb, novel behavior.
- The boundary indicator evolved from a hard border (felt disconnected from the page) to a subtle **halo shown on hover/edit only** — visible when relevant, invisible when reading.
- Permission mismatches (editor of one location lacking access to another) are real and need explicit warnings; the editor surfaces them contextually rather than blocking.

### 5. Databases inside the block model

Internal architecture (documented by [notion-py](https://pypi.org/project/notion/0.0.19), which wraps the private API):
- **`collection`** — a non-block record holding the **schema** (property definitions: name, type, options) and acting as *parent* of the rows.
- **`collection_view`** (inline) / **`collection_view_page`** (full-page) — blocks placed in the document; each carries pointers to the collection and to a list of **view** records.
- **`collection_view`** records (views) hold layout kind (table/board/timeline/calendar/list/gallery), filters, sorts, visible properties, grouping.
- **Rows are page blocks** whose `parent` is the collection and whose `properties` contain values keyed by schema property IDs. "A row in a database" is a full page — you can open it, fill it with arbitrary blocks, nest databases in it.

This yields Notion's signature tricks at near-zero model cost: any row opens as a document; "linked databases" are just additional view blocks pointing at the same collection; the same data renders as board or table because views are presentation records, not copies of data.

**2025 evolution — data sources** ([Upgrade guide 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03)): a database is now a *container of one or more data sources*, each data source having its own schema and rows; views can draw from multiple sources. The API break (new `/v1/data_sources` endpoints, mandatory `data_source_id` discovery step) shows the cost of having conflated "the container/views" with "the table" in v1 — old integrations can't even see multi-source databases. Separate these concepts from day one: **container block ≠ view ≠ schema+rows**.

Rollups/relations pagination is genuinely hard: the API team encodes *partial aggregation state into pagination cursors* so `Sum`/`Count`/`Max` can be computed incrementally across batches — but `Median` can't be ([Creating the Notion API](https://www.notion.com/blog/creating-the-notion-api)).

### 6. The public API as a window into the internal model

[Creating the Notion API](https://www.notion.com/blog/creating-the-notion-api) documents three decisions that map internal → public:
- **JSON, not Markdown**: "No widely-used Markdown implementation supports underlined or colored text, block or inline equations, callout blocks, toggle blocks, or dynamic user and date mentions." Markdown "is simply not expressive enough… such as custom importers and exporters." The public block object is a cleaned-up rename of the internal record (`text`→`paragraph`, `header`→`heading_1`, per-type payload instead of loose `properties`/`format`).
- **Breadth-first pagination**: children are never inlined; you get top-level blocks and recurse via "retrieve block children" per block (`has_children` flags it). Predictable latency, but building a full tree costs one round-trip per parent — the pain every exporter hits ([Building a Notion to Markdown tool is annoying actually](https://altf4.blog/blog/2024-02-25-building-a-notion-to-markdown-tool-is-annoying-actually/)).
- **Global date-based versioning** (Stripe-style) rather than per-resource versions.

The API also reveals model edges honestly: `unsupported` block type with a `block_type` hint for anything not yet mapped (`form`, `button`); `link_preview` is read-only; `table` width is fixed at creation; `template` blocks; toggleable headings via `is_toggleable` rather than a separate type (a nice reuse of "type change preserves data").

### 7. UX patterns worth copying, in detail

Sources: [Keyboard shortcuts help](https://www.notion.com/help/keyboard-shortcuts), [What is a block?](https://www.notion.com/help/what-is-a-block), [Columns help](https://www.notion.com/help/columns-headings-and-dividers), [Using slash commands](https://www.notion.com/help/guides/using-slash-commands).

**Slash command menu.** `/` on any text position opens an inserter listing every block type + actions, grouped by category (Basic blocks, Media, Database, Advanced, inline). Continue typing to filter in real time (`/image` narrows to Image; Enter inserts without touching the mouse). Aliases matter (`/h1`, `/#`, `/todo`, `/div`, `/math`, `/turn`, `/color` for colors). Related sigils open scoped menus: `@` (person/page/date mention, `@remind`), `[[` (link page, create-page options deprioritized), `+` (create page, link options deprioritized) — same machinery, different ranking. Deleting back past the `/` or pressing Escape dismisses; the typed filter text remains as literal text if dismissed.

**Hover controls.** Hovering any block reveals, in the left margin: **`+`** (insert a new block below; Alt/Option-click inserts above) and the **`⋮⋮` drag handle**. Click the handle → block menu: Turn into, Color, Duplicate, Delete, Copy link to block (every block is URL-addressable — anchor = block UUID), Move to, Comment, Ask AI. Controls are invisible until hover — the page reads as a clean document; affordances appear at ~150ms fade only where the pointer is.

**Drag and drop.** Dragging by `⋮⋮` shows the block ghost; candidate drop positions render as a **horizontal blue line** between blocks (nesting depth indicated by the line's indent) or a **vertical blue line** at a block's side edge — the vertical guide is the entire column-creation UI. No modes, no layout dialog. Multi-block drags move the whole selection.

**Block selection mode.** Two editing regimes with an explicit switch: **Escape** leaves text editing and selects the current block (blue overlay wash over the block); **Enter** re-enters text editing. In block-selection mode: arrows move selection between blocks, Shift+↑/↓ extends it, Cmd/Ctrl+A escalates (select block text → select block → select all blocks), click-drag on the page background lassos blocks, Shift+click extends, Cmd/Ctrl+D duplicates, Backspace deletes, Cmd/Ctrl+Shift+arrows *moves* the selected blocks up/down/in/out, and typing a slash or `⋮⋮`-menu keystroke acts on the whole selection. Since [Jan 2022](https://www.notion.com/releases/2022-01-19), click-drag from *inside* text does word-processor-style **partial text selection across blocks** ("select, cut, copy & paste partial text across paragraphs, bullet lists, callouts & more"), degrading to whole-block highlighting once selection spans non-text boundaries. It took Notion ~5 years to ship this and it initially excluded Firefox — plan for it from the start.

**Turn into.** Available from the `⋮⋮` menu, from `/turn`, from the selection toolbar, and via shortcuts (Cmd/Ctrl+Opt/Shift+0–9: text, h1–h3, to-do, bullet, numbered, toggle, code, page). Works on multi-selections. Because type changes are non-destructive (see §1), the menu never warns or converts irreversibly.

**Markdown autoformat while typing** (input rules, applied at the moment the trigger char/space is typed, undoable as a single step): `**bold**`, `*italic*`, `` `code` ``, `~strike~` inline; at line start `-`/`*`/`+`+space → bullet, `[]` → to-do, `1.`/`a.`/`i.`+space → numbered (with letter/roman list formats), `#`/`##`/`###`+space → headings, `>`+space → toggle, `"`+space → quote, `---` → divider. Note the deliberate deviation: `>` is *toggle*, not quote — Notion optimized for its own most-used block over Markdown fidelity.

**Placeholders.** Empty page: title placeholder "Untitled" + ghost menu of starter actions. Empty text block shows **"Type '/' for commands"** *only when the caret is in it* — never on every empty line, so the page doesn't fill with gray noise. Empty headings show "Heading 1" etc. Placeholder = discoverability channel for the slash menu; it's how users learn the whole insert system without a toolbar.

**Toggles & transitions.** Toggle arrow rotates ~90° with a short ease; children reveal with height animation; Cmd/Ctrl+Opt/Alt+T opens/closes all toggles at the current level. Hover states throughout are subtle background washes (`~3–5%` alpha) and 100–200ms opacity fades — the polish is consistency, not flourish.

**Side peek / center peek / full page** ([release 2022-07-20](https://www.notion.com/releases/2022-07-20)): database rows open by default in a **side peek** — a right panel with the database still interactive on the left — or center peek (modal) or full page; configurable per view (`Layout → Open pages in`), with defaults per view type (table/board/timeline/list → side peek; calendar/gallery → center). Side peek is the key to "rows are pages" feeling lightweight: you preview/edit a document without losing list context.

### 8. Criticisms and limitations (what the model costs)

**Performance on large pages.** The block model's cost is fan-out: rendering needs thousands of small records, `loadPageChunk` must walk arbitrary-depth trees, and relations/rollups recompute on open ("50 properties × 500 pages" pathologies; circular relation chains ballooning load times — [Falconer: Why is Notion slow](https://falconer.com/guides/why-is-notion-slow/)). Notion's own fixes are telling: native-app SQLite caching, then [WASM SQLite in the browser](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) (20% faster navigation overall, 28–33% in high-latency regions) using OPFS + a SharedWorker that elects one active tab as the sole writer — after multi-tab concurrent writes *corrupted the database* ("multiple rows with the same ID but different content"), and with regressions on slow devices requiring disk-vs-network races. Local cache architecture is not an optimization to bolt on later; it is half the product.

**Offline.** Notion ran cloud-first for ~9 years; true offline shipped only in [v2.53, August 19, 2025](https://www.notion.com/releases/2025-08-19), and it is *opt-in per page* ("Available offline" toggle; auto-download of recents on paid plans). Limitations: only the first 50 rows of the first view of a database sync; sub-pages aren't included automatically; live-data features (embeds, forms) don't work; mobile syncs on Wi-Fi only. Text edits merge via CRDTs, but property changes/row deletions/reordering can still conflict ([Notion Backups guide](https://notionbackups.com/guides/notion-offline-mode), [9to5Mac](https://9to5mac.com/2025/08/20/notion-offline-mode/)). Lesson: retrofitting offline onto a server-validated transaction pipeline is a decade-scale debt.

**Markdown export is lossy.** Columns export as non-standard `<columns>` wrapper tags or flatten to sequential content; toggles flatten to details/indent; callouts become blockquote-with-emoji or raw HTML; colors, synced-block identity, and view configurations are dropped; databases export as separate CSV files linked from the page ([Raccoon Page: export limitations](https://raccoon.page/blog/notion-export-limitations/), [MarkdownTools blog](https://blog.markdowntools.com/posts/markdown-for-notion-what-actually-works)). Combined with breadth-first API pagination and per-block rate limits, faithful export requires a custom tool and still loses semantics ([altf4.blog](https://altf4.blog/blog/2024-02-25-building-a-notion-to-markdown-tool-is-annoying-actually/)). Users experience this as lock-in — exactly the thing our storage-readable-without-the-tool principle targets.

**Editor mechanics.** Notion renders each text block as its own contentEditable element (non-text blocks are plain DOM), which keeps per-block editing simple but made document-level behaviors — cross-block partial selection, uniform caret traversal, find-in-page highlighting — expensive retrofits (patent filings describe an in-memory selection state layered over the per-block DOM; Firefox support lagged). Spell-check context, IME behavior, and browser-native find suffer at block boundaries.

## Pitfalls

1. **Don't couple layout containers to hand-managed lifecycles.** `column_list`/`column` as blocks is right, but every operation that can empty a column must garbage-collect wrappers, or documents accumulate invisible broken containers (a classic source of "ghost blocks" bugs in Notion clones).
2. **Don't derive permissions/ancestry by walking the render tree.** Notion added the redundant `parent` pointer precisely because content arrays are ambiguous (multi-referenced blocks) and slow to invert. If we ever have sharing or scoped features, we need the upward pointer from day one — and code to keep the two mirrored, because Notion admits "edge cases we're working to clean up."
3. **Don't make block type conversion destructive.** The moment "turn into" drops data, users stop trusting it. Keep unknown/unused properties on the record, ignore them at render.
4. **Don't build the text layer per-block-only.** Per-block contentEditable without a document-level selection model cost Notion five years of "can't select text across paragraphs" and still excludes some browsers. The selection/caret model must span blocks from the first design.
5. **Don't conflate database container, schema, and view.** Notion's 2025 "data sources" migration was a breaking API change to untangle exactly this. Keep *view block*, *view config*, and *schema+rows* as three record kinds.
6. **Don't treat local persistence as a cache-later optimization.** Multi-tab SQLite corruption, slow-device regressions, and the 9-year offline gap all trace to bolting persistence onto a cloud-first pipeline. Also: never allow two writers to one local DB — single-writer election (SharedWorker/Web Locks) is mandatory on web.
7. **Don't promise Markdown round-tripping you can't deliver.** Markdown cannot express columns, toggles, callout semantics, colors, mentions, or synced identity. Either extend the format explicitly (and document it) or accept defined loss — silent dropping is what people resent Notion for.
8. **Don't inline children in load/list APIs.** Breadth-first with `has_children` keeps latency bounded; but design a batch "give me this subtree" call too, or every exporter re-implements recursive crawling against rate limits.
9. **Don't put backlinks in user-editable storage.** They are an index over mentions; storing them as authored data guarantees drift.
10. **Don't show affordances permanently.** Notion's entire chrome (handles, placeholders, sync halos) appears on hover/focus only. Clones that render drag handles and placeholders on every block read as toy UIs.

## Recommendations for our editor

**Data model**
1. Adopt the four-field block core: `id` (UUID, client-generated), `type` (string), `props` (open map — preserve unknown keys), `children` (ordered ID array). Add `parentId` as a maintained inverse even though we start single-user: transclusion and page links already make the structure a graph, and Swift/Obsidian/p2p consumers all want O(1) upward walks.
2. Make pages blocks. Sub-page = block in the tree; link-to-page = distinct `alias`-style block; inline mention = rich-text span with `pageId`. Three constructs, never conflated.
3. Rich text = flat segment array per block: `{text, marks: [{type, attrs?}]}`, closed set of mark types (bold/italic/strike/code/link/color/mention/equation/comment-anchor). No nested marks, no cross-block spans. Precompute nothing except optionally `plainText` at serialization boundaries.
4. Columns = `columnList` → `column(widthRatio)` → any block; enforce invariants (≥2 columns, ratios sum≈1) in the core with automatic wrapper GC on every move/delete.
5. Databases: separate `viewBlock` (placement), `view` (layout+filter+sort config), `schema`, and rows-as-page-blocks parented under the data source. Multiple view blocks may target one source (linked views for free).
6. Synced blocks: original-owns-children + reference-points-at-original (`syncedFrom`), copy/paste as the creation gesture, hover halo as the boundary UI.
7. Soft delete (`alive`/`inTrash` flag + unlink) rather than hard delete — powers trash, undo across sessions, and sync tombstones.
8. Mutations = named operations batched into transactions from day one (even before sync exists): it gives us undo/redo, an audit trail, and the exact unit a future CRDT/p2p layer needs. This is the cheapest early decision with the biggest later payoff.

**UX**
9. Ship the six-pattern core first, at high fidelity: slash menu with real-time filtering + aliases; hover `+`/`⋮⋮` with the block menu; Escape/Enter block-vs-text mode with arrow/Shift-arrow selection; blue drop guides where the vertical guide *is* column creation; the full markdown autoformat table (decide consciously whether `>` = quote or toggle); caret-only "Type '/' for commands" placeholder.
10. Build cross-block text selection into the selection model from the start (document-level selection state mapped onto per-block DOM), even if v1 renders it as whole-block highlight — the coordinate system `(blockId, offset)` must exist early.
11. Copy Notion's non-destructive Turn Into everywhere, including multi-select.
12. Side peek for row-pages; per-view "open as" setting with sensible defaults.
13. Every block gets a stable URL/anchor (its ID) — "Copy link to block" is cheap with UUIDs and unlocks deep-linking and backlink granularity.

**Storage / portability (our differentiator vs Notion)**
14. Our schema→Markdown mapping must be *defined and round-trippable by design*: pick explicit encodings now for the constructs Markdown lacks (columns, toggles, callouts, colors, mentions, synced refs) — e.g. attributed containers/directives — and treat "exports cleanly without our tool" as a test suite, not a feature.
15. Local-first from commit one: single-writer local store, transaction queue, optimistic apply. We get for free what Notion spent 2015–2025 retrofitting.

## Sources

- [The data model behind Notion's flexibility — Notion blog](https://www.notion.com/blog/data-model-behind-notion)
- [Block — Notion API reference](https://developers.notion.com/reference/block)
- [Rich text — Notion API reference](https://developers.notion.com/reference/rich-text)
- [Creating the Notion API — Notion blog](https://www.notion.com/blog/creating-the-notion-api)
- [Designing Synced Blocks — Notion blog](https://www.notion.com/blog/designing-synced-blocks)
- [Herding elephants: lessons learned from sharding Postgres at Notion](https://www.notion.com/blog/sharding-postgres-at-notion)
- [How we sped up Notion in the browser with WASM SQLite — Notion blog](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- [Upgrade guide 2025-09-03 (data sources) — Notion Docs](https://developers.notion.com/docs/upgrade-guide-2025-09-03)
- [How Notion Was Built: Block Model, Architecture, and Sync Pipeline — HowWorks](https://howworks.ai/blog/how-notion-was-built)
- [kjk/notionapi — reverse-engineered Go client (block.go, inline_block.go)](https://github.com/kjk/notionapi)
- [notion-py — unofficial Python client (collection/collection_view internals)](https://pypi.org/project/notion/0.0.19)
- [Keyboard shortcuts — Notion Help](https://www.notion.com/help/keyboard-shortcuts)
- [What is a block? — Notion Help](https://www.notion.com/help/what-is-a-block)
- [Columns, headings & dividers — Notion Help](https://www.notion.com/help/columns-headings-and-dividers)
- [Links & backlinks — Notion Help](https://www.notion.com/help/create-links-and-backlinks)
- [Using slash commands — Notion guide](https://www.notion.com/help/guides/using-slash-commands)
- [Release 2022-01-19: Better text editing & copy/paste](https://www.notion.com/releases/2022-01-19)
- [Release 2022-07-20: database side peek](https://www.notion.com/releases/2022-07-20)
- [Release 2025-08-19: Notion 2.53 Offline mode](https://www.notion.com/releases/2025-08-19)
- [Notion offline mode guide — Notion Backups](https://notionbackups.com/guides/notion-offline-mode)
- [Notion gains offline mode — 9to5Mac](https://9to5mac.com/2025/08/20/notion-offline-mode/)
- [Building a Notion to Markdown tool is annoying actually — altf4.blog](https://altf4.blog/blog/2024-02-25-building-a-notion-to-markdown-tool-is-annoying-actually/)
- [Notion export limitations — Raccoon Page](https://raccoon.page/blog/notion-export-limitations/)
- [Markdown for Notion: what works and what doesn't — MarkdownTools](https://blog.markdowntools.com/posts/markdown-for-notion-what-actually-works)
- [Why is Notion so slow? — Falconer](https://falconer.com/guides/why-is-notion-slow/)
- [The Tech Stack Behind Notion's Block-Based Editor — TechAhead](https://www.techaheadcorp.com/blog/tech-stack-powering-notion-block-based-editor/)
