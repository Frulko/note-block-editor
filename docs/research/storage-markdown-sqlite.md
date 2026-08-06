# Storage & Interop: Markdown / CSV / SQLite as a Tool-Independent, Human-Readable Store

Research note for the notion-block-editor project. Researched August 2026. Every claim is source-backed; URLs inline and in the Sources section.

## TL;DR

- Markdown can carry ~80% of a block editor's constructs losslessly (paragraphs, headings, lists, task lists, quotes, code, tables, images, links); the remaining 20% — columns, toggles, callouts, embeds, synced blocks, and **all** database/view semantics — require an extension convention, and every serious product has invented one.
- Four extension families exist in the wild: YAML frontmatter (metadata), fenced `:::` directives with `{attributes}` (Pandoc/Djot/markdown-it-container), HTML comments as block delimiters with JSON payloads (WordPress Gutenberg), and XML-ish inline tags (Notion's own new "Enhanced Markdown" API format). MDX is a compile-time programming format, not a storage format — reject it.
- Notion itself now ships a Notion-flavored Markdown over its API (`<columns>`, `<details>`, `<callout>`, `{color=...}` attributes) — strong validation that "Markdown + typed containers" is the industry answer; its classic ZIP export meanwhile remains deeply lossy (views, filters, formulas, rollups, relations, comments, history all gone; UUID-suffixed filenames).
- Obsidian's flavor is precisely documentable and stable: `[[wikilinks]]`, `![[embeds]]`, `#^block-ids`, `> [!callout]` types, `%%comments%%`, `==highlight==`, YAML properties with six types, and the new **Bases** core plugin: `.base` YAML files defining filtered/sorted/grouped table/cards/list/map views over note frontmatter — a plain-text database-view design we can adopt nearly wholesale.
- Nobody in the local-first block-editor space uses Markdown as the canonical in-memory model. SiYuan: JSON AST per document (`.sy`) + SQLite index. Anytype: protobuf objects + `any-store`, a Mongo-style document DB **on SQLite**. AFFiNE: Yjs CRDT binary + JSON block snapshots. Notion clients: SQLite as an LRU RecordCache, never source of truth. The universal pattern is **canonical structured model + SQLite as derived index/cache + text export**.
- SQLite in 2026 is a fully capable document store: JSON1 + binary JSONB (3.45+), FTS5 full-text search with contentless-delete tables (3.43+), WAL concurrency, and even runs in-browser via WASM+OPFS (Notion shipped this, 20–33% faster navigation).
- CSV wins for git-diffable, human-readable database *content*; SQLite wins for queries, indexes, and views — they are not competitors: CSV is the projection, SQLite is the cache.
- "File over app" (Steph Ango) and local-first (Ink & Switch) converge on the same requirement: the durable artifact must be files the user controls in formats readable without the tool; the app and its databases must be rebuildable from those files.
- Recommended architecture: canonical JSON block schema (source of truth) ⇄ Markdown+CSV+`.base` projection (readable, git-friendly, lossy-tolerant with a defined fidelity boundary) ⇄ optional SQLite (index/FTS/db-views cache, always rebuildable, never authoritative).

## Findings

### 1. What maps losslessly to CommonMark/GFM — and what does not

CommonMark gives us: paragraphs, ATX/setext headings, bulleted/numbered lists (with nesting), block quotes, fenced/indented code blocks, thematic breaks, inline emphasis/strong/code/links/images, and raw HTML passthrough. [GFM](https://github.github.com/gfm/) adds exactly five extensions to that spec: tables, task list items, strikethrough, autolinks, and disallowed-raw-HTML. Footnotes, math, and highlights are GitHub *renderer* features, not part of the GFM spec.

**Maps losslessly (structure and content survive round-trip):**

| Block construct | Markdown mapping | Caveats |
|---|---|---|
| Paragraph, heading 1–6 | native | Notion only has H1–H3; we have full range |
| Bulleted / numbered list | native | marker style + tight/loose is presentational |
| To-do / task list | GFM `- [ ]` / `- [x]` | universal |
| Quote | `>` | none |
| Code block | fenced + info string | language survives in info string |
| Divider | `---` | none |
| Image (simple) | `![alt](path)` | sizing/caption need extension |
| Table (simple) | GFM pipe table | **no** block content in cells, no merged cells, no column widths |
| Inline: bold/italic/code/strike/link | native + GFM | fine |

**Does NOT map — requires extension syntax:**

- **Columns / column lists** — no Markdown concept of horizontal layout at all. Notion's export historically just flattens columns into sequential blocks; its new API format wraps them in `<columns>`/`<column>` tags ([Enhanced Markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown), [mdstill](https://mdstill.com/blog/notion-markdown-export-quirks)).
- **Toggles / collapsible blocks** — "Markdown has no toggle." Notion's ZIP export flattens them: title becomes a paragraph/heading, hidden children become sibling paragraphs, "the structural relationship is gone" ([Raccoon Page](https://raccoon.page/blog/notion-export-limitations/), [Notion Backups](https://notionbackups.com/guides/export-notion-to-markdown)). The least-bad portable encoding is HTML `<details><summary>`, which Notion's API format now uses — but most Markdown renderers treat the interior as raw HTML, killing nested Markdown rendering.
- **Callouts** — no CommonMark construct. Two conventions dominate: Obsidian/GitHub-style decorated blockquote `> [!note]` (degrades to a plain quote in any other renderer — excellent property) and Notion's `<callout>` tag / emoji-prefixed quote on export.
- **Embeds / media blocks** (video, audio, PDF, bookmarks, tweets, Figma...) — export "as a link to the source, not the object" ([Raccoon Page](https://raccoon.page/blog/notion-export-limitations/)). Notion's API format has dedicated `<video>`, `<audio>`, `<pdf>`, `<file>` tags.
- **Synced blocks** — a live identity relationship; text files can only hold static copies, duplicated at every location ([Raccoon Page](https://raccoon.page/blog/notion-export-limitations/)).
- **Databases and views** — the biggest gap. Rows can go to CSV; but views, filters, sorts, groupings, formulas (the *logic*, not last value), rollups, and relations have **no** Markdown/CSV representation whatsoever. "Views are rendering instructions, not stored data... Filters and sorts don't export at all, because they were never content" ([Raccoon Page](https://raccoon.page/blog/notion-export-limitations/)). Obsidian's Bases `.base` YAML is the first mainstream plain-text answer to exactly this (see §4).
- **Presentation state**: text/background colors, block-level formatting, cover images, icons — droppable or attribute-encoded only.
- **Stable block identity** — CommonMark has no block IDs. Obsidian bolts on `^block-id` suffixes; SiYuan gave up on Markdown as storage *specifically* to keep IDs stable (see §5). Any construct that needs to be referenced (block refs, sync, CRDT addressing) needs identity that vanilla Markdown cannot hold.

**Complex tables** deserve a special note: GFM tables can't contain block elements, merged cells, or per-column metadata. Any editor with Notion-style "simple tables" survives; database-tables do not belong in Markdown tables at all.

### 2. Extension strategies in the wild

#### 2a. YAML frontmatter

The universal convention for *document-level* metadata: `---`-delimited YAML at the top of the file, standardized by Jekyll, supported by Pandoc as `yaml_metadata_block` ([Pandoc manual](https://pandoc.org/MANUAL.html)) and by Obsidian as "Properties" ([Obsidian help](https://obsidian.md/help/properties)). Obsidian types frontmatter values: Text, List, Number, Checkbox, Date (`YYYY-MM-DD`), Date & Time (`YYYY-MM-DDTHH:MM:SS`), with reserved keys `tags`, `aliases`, `cssclasses`; a property name's type is vault-global; internal links inside properties must be quoted strings (`"[[Page]]"`). Frontmatter is the natural home for page-level properties (created/updated, icon, cover, database fields of a page-row) but cannot express anything block-level.

#### 2b. Fenced `:::` directives (Pandoc fenced divs, markdown-it-container, Djot)

Pandoc's `fenced_divs`: three-or-more colons, optional `{.class #id key="value"}` attributes, nestable, interior parsed as Markdown ([Pandoc manual](https://pandoc.org/MANUAL.html)); paired with `bracketed_spans` (`[text]{.class}`) for inlines. [markdown-it-container](https://github.com/markdown-it/markdown-it-container) implements the same shape for the markdown-it ecosystem (VuePress/VitePress `::: tip` / `::: warning` containers) with pluggable validate/render functions. This family is the closest thing to a *community standard* for typed block containers that remain readable as plain text and degrade gracefully (unknown container → its inner content still renders). There is also a formal CommonMark "generic directives" proposal (`:::name[label]{attrs}`) that never landed in the spec but is implemented by remark-directive — same idea, same shape.

#### 2c. HTML comments as block delimiters (Gutenberg)

WordPress Gutenberg serializes its block tree into post HTML using comment delimiters carrying the block name plus JSON attributes:

```html
<!-- wp:core/code {"language":"haskell"} -->
<code><pre>...</pre></code>
<!-- /wp:core/code -->
```

The design rationale is explicit and instructive: "a Gutenberg post is built upon an in-memory data structure which gets persisted somehow in a fully-isomorphic way"; the hybrid was chosen so legacy renderers still show valid HTML while the editor can re-parse exact block structure; comments are "semantically neutral," and storing the tree separately from the rendered HTML was rejected because of "the risk of the post_content and the tree getting out of sync and the duplication of data in both places" ([Gutenberg posts aren't HTML](https://fluffyandflakey.blog/2017/09/04/gutenberg-posts-arent-html/), [Gutenberg serializer](https://github.com/WordPress/gutenberg/blob/774713c0467779a9651983ec96609a6637811132/packages/blocks/src/api/serializer.js)). Attributes are `JSON.stringify`-ed then regex-escaped so they can't break the comment or non-compliant tools; block authors decide per-attribute whether data lives in the JSON comment or is re-parsed out of the inner HTML, with guidance to prefer HTML "to reduce the amount of data stored" in comments ([Block attributes handbook](https://developer.wordpress.org/block-editor/developers/block-api/block-attributes)). Lesson: invisible-but-machine-precise delimiters work, but a human editing the file can silently break the JSON, and the same data living in two places (attributes + inner HTML) is a permanent consistency tax.

#### 2d. XML-ish tags in Markdown (Notion Enhanced Markdown, 2025+)

Notion's Data APIs now speak "Notion-flavored Markdown" on three endpoints (`POST /v1/pages`, `GET /v1/pages/:page_id/markdown`, `PATCH .../markdown`). It extends standard Markdown with XML-like tags for exactly the constructs that don't map: `<details>/<summary>` (toggles), `<callout>`, `<columns>/<column>`, `<audio>/<video>/<file>/<pdf>`, `<page>/<database>` references, `<synced_block>/<synced_block_reference>`, `<table_of_contents>`, `<empty-block/>`, mention tags (`<mention-user>`, `<mention-page>`, `<mention-date start=... timeZone=...>`), plus `{color="Blue"}`-style attributes on rich text and headings, `# Heading {toggle="true"}`, and tab-indentation for child blocks ([Enhanced Markdown guide](https://developers.notion.com/guides/data-apis/enhanced-markdown)). This is the strongest recent evidence that even Notion concluded "Markdown + typed containers/attributes" is the right interchange surface — while notably still *not* attempting to encode database views/formulas in it.

#### 2e. MDX — rejected for storage

MDX combines Markdown with JSX, JS expressions, and ESM imports; it is "an odd mix of two languages: markdown is whitespace sensitive and forgiving... whereas JavaScript is whitespace insensitive and unforgiving (it does crash on typos)" ([What is MDX?](https://mdxjs.com/docs/what-is-mdx/)). It is a *compiled programming-language format*: invalid syntax crashes, indented code blocks are unsupported, `<` and `{` must be escaped. A storage format must be forgiving and readable without a JS toolchain; MDX is neither. Useful only as an optional *export target* for docs-site users.

#### 2f. Djot — the stricter alternative

[Djot](https://github.com/jgm/djot) (John MacFarlane, CommonMark's own spec author, fixing his regrets) parses in linear time with no backtracking, requires blank lines between blocks, simplifies emphasis from CommonMark's 17 rules, and crucially has **built-in** attributes-on-any-element (`{#id .class key="val"}`), generic fenced divs, bracketed spans, tables, footnotes, definition lists, highlights, ins/del, sub/superscript, and math — i.e., natively expresses most of what we'd otherwise bolt onto Markdown. Raw HTML is banned outside explicit raw blocks. Seven implementations exist (JS/TS `djot.js` is the reference; also Rust, Go, Haskell, Lua, PHP, Prolog) ([README](https://github.com/jgm/djot/blob/main/README.md), [implementations list](https://github.com/jgm/djot/discussions/265)). Verdict: technically the better projection *language*, but ecosystem gravity (GitHub, Obsidian, every renderer on earth) is Markdown's; Djot remains niche in 2026. It should inform our *syntax choices* (attribute syntax, div semantics), not be our primary export.

### 3. Notion's export — exactly what gets lost

Mechanics ([Notion help](https://www.notion.com/help/export-your-content)): "Any non-database Notion page can be exported as a Markdown file. Full page databases will be exported as a CSV file, with Markdown files for each subpage." Subpages become nested folders; images/assets are saved alongside. Comments export **only** in HTML format, not Markdown. Form-view databases can't be exported at all.

Losses, per [Raccoon Page's 2026 teardown](https://raccoon.page/blog/notion-export-limitations/), [Notion Backups](https://notionbackups.com/guides/export-notion-to-markdown), and [mdstill](https://mdstill.com/blog/notion-markdown-export-quirks):

- **Toggles** flatten: title becomes a paragraph, children become same-level siblings — hierarchy destroyed.
- **Callouts** degrade to blockquote-with-emoji-prefix.
- **Columns** flatten into sequential content (no layout trace).
- **Synced blocks** "export as a static copy at every location they appeared."
- **Embeds** become bare links "to the source, not the object."
- **Equations** can degrade to plain text in Markdown export.
- **Databases**: rows → CSV with visible properties only. "Database views (board, calendar, gallery, timeline) gone... Filters and sorts don't export at all... rollups and formulas export their last computed value, not their logic." Relations export as raw UUIDs, not human-readable links. Linked databases duplicate rows wherever they were embedded.
- **Filenames**: every page gets a 32-hex-char UUID suffix; internal links rewrite to those filenames — "the single most-reported Notion export complaint" — and deep nesting can exceed Windows' 260-char path limit.
- **Some asset references** still point at time-limited signed URLs that "work the day you export and quietly 403 later."
- **Comments, page history, permissions**: entirely absent (comments HTML-only).

Root cause framing worth internalizing: "It is a structural mismatch between what Notion can represent and what markdown can represent. The export will always be lossy because the source is richer than the target format" ([Restora](https://restora.cc/blog/what-notion-export-leaves-behind)). Our design goal is therefore not "lossless Markdown" but a *defined, minimized, recoverable* loss boundary.

### 4. Obsidian's flavor, precisely (future integration target)

Base: CommonMark + GFM + LaTeX. One hard deviation: "Obsidian does not render Markdown syntax inside HTML elements" ([Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown)) — so `<details>`-style encodings render poorly in Obsidian; prefer constructs Obsidian understands natively.

**Links & embeds** ([Internal links](https://obsidian.md/help/links)):
- Wikilink `[[Note]]`, alias `[[Note|Display]]`, heading `[[Note#Heading]]`, nested heading `[[Note#H1#H2]]`, block ref `[[Note#^block-id]]` (auto `^37066d` or custom `^my-id`; Latin letters/numbers/dashes only).
- Embed = `!` prefix: `![[image.png]]`, `![[Note]]`, `![[Note#^block]]`.
- Resolution: shortest matching path from vault root; standard Markdown links (`[text](Note.md#heading)`, `%20`-encoded) work as fallback when wikilinks are disabled.

**Callouts** ([Callouts](https://obsidian.md/help/callouts)): `> [!type]` on a blockquote's first line; 15 types with aliases — note, abstract (summary/tldr), info, todo, tip (hint/important), success (check/done), question (help/faq), warning (caution/attention), failure (fail/missing), danger (error), bug, example, quote (cite). Case-insensitive; unknown types render as note (graceful). Foldable: `[!type]+` (open) / `[!type]-` (collapsed) — i.e., **Obsidian callouts double as toggles**. Custom title after the tag; nestable via `>>`.

**Other syntax**: `%%comment%%`, `==highlight==`, `~~strike~~`, footnotes `[^id]`, task lists, mermaid code fences, `$...$`/`$$...$$` math ([Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown)).

**Properties** ([Properties](https://obsidian.md/help/properties)): YAML frontmatter, six types (Text/List/Number/Checkbox/Date/DateTime), type-per-name is vault-global, JSON frontmatter accepted but rewritten to YAML, reserved `tags`/`aliases`/`cssclasses`.

**Bases** ([Bases syntax](https://obsidian.md/help/bases/syntax), [views](https://obsidian.md/help/bases/views), [Obsidian roadmap](https://obsidian.md/roadmap/)): core plugin since 1.9 (2025); "your data stays in local Markdown, the view logic lives in a `.base` file or an embedded base code block." A `.base` is YAML with five top-level sections:

```yaml
filters:
  and:
    - file.hasTag("book")
    - 'status != "done"'
formulas:
  ppu: "(price / age).toFixed(2)"
properties:
  status: { displayName: Status }
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table          # table | cards | list | map (map needs Maps plugin)
    name: "My table"
    limit: 10
    filters: ...
    groupBy: { property: note.age, direction: DESC }
    order: [file.name, formula.ppu]
    summaries: { formula.ppu: Average }
```

Key semantics: no `from` clause — a base's dataset is *the whole vault* narrowed by filters over note/file properties (`note.price`, `file.name`, `file.size`, `formula.x`, `this` for context); a small expression language (`if()`, `.toFixed()`, date arithmetic with `"7d"` durations, `&&`/`||`); built-in summaries (Average, Min, Max, Sum, Median, Stddev, Earliest/Latest, Checked/Unchecked, Empty/Filled/Unique); table edits write back into note frontmatter ([dsebastien](https://www.dsebastien.net/how-i-turned-20-000-notes-into-live-dashboards-with-obsidian-bases/), [got.md guide](https://got.md/obsidian-bases/)). **This is the "database as files" architecture**: rows = notes, properties = frontmatter, views = a declarative YAML file. It maps almost 1:1 onto "Notion database exported as one file per row + a view-definition file," which is exactly the projection we need.

### 5. Databases: CSV vs SQLite; SQLite as a document store; prior-art schemas

**CSV vs SQLite for collection data.** CSV: universally readable, git-diffable line-per-row, zero tooling — but untyped (everything is a string), no schema, no relations, no multi-valued cells without convention, and encoding/quoting edge cases. SQLite: typed, indexed, queryable, transactional, single file — but binary (git sees an opaque blob), unreadable without a tool (though *any* SQLite tool, forever — it's a Library-of-Congress-recommended format). The [SQLite-as-application-file-format essay](https://www.sqlite.org/appfileformat.html) lists the wins (single-file document metaphor, atomic transactions, incremental updates, "accessible content — not an opaque blob," extensible schema) and the honest caveats ("SQLite is not the perfect application file format for every situation"; opening untrusted DB files needs defenses). For a git-friendly, human-first store, CSV/Markdown is the projection; SQLite belongs in the derived layer.

**SQLite as a document store (2026 state):**
- **JSON1 + JSONB**: full JSON query/update functions; since 3.45 (Jan 2024) the binary `JSONB` format halves parse cost; `jsonb_each()`/`jsonb_tree()` added later; 3.51 (2025) fixed lingering `jsonb_set` bugs ([SQLite changelog](https://sqlite.org/changes.html), [x-cmd 3.51 notes](https://www.x-cmd.com/blog/251108/)). You can index expressions over JSON (`CREATE INDEX ... ON docs(json_extract(body,'$.type'))`).
- **FTS5**: full-text search with BM25, prefix queries, highlight/snippet; external-content tables index your real table without duplicating text; contentless-delete tables (3.43+) allow deletion without storing content ([FTS5 docs](https://www.sqlite.org/fts5.html)).
- **WAL**: readers don't block the writer and vice versa — the right journal mode for an interactive editor with background indexing ([WAL docs](https://www.sqlite.org/wal.html)).
- **Browser**: Notion runs WASM SQLite over OPFS with a per-tab Web Worker + SharedWorker electing a single active writer tab (Web Locks detect tab death for failover) after multi-tab concurrent writes **corrupted the database**; they chose the OPFS SyncAccessHandle Pool VFS to avoid cross-origin-isolation headers; async loading + racing SQLite reads against API calls fixed initial regressions; result 20% faster navigation (33% in India) ([Notion WASM SQLite post](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)).

**Prior-art persistence schemas:**

- **Notion (the canonical block model)**: every block = `{id (UUIDv4), type, properties (e.g. title), content (ordered array of child block IDs), parent (for permissions only)}`; nesting via downward `content` pointers, permissions via upward `parent`; "blocks nested inside other blocks, like text inside a toggle or infinitely nested sub-pages inside of pages" ([The data model behind Notion](https://www.notion.com/blog/data-model-behind-notion)). Record types include `block`, `space`, `collection`, `collection_view`, `notion_user` — note that a database is a `collection` and each *view* is a first-class `collection_view` record. Clients keep an LRU **RecordCache** over SQLite (desktop, since 2021: 50% faster loads) or IndexedDB, plus a **TransactionQueue** persisting pending edits until server-acknowledged — SQLite is *never* the source of truth, always a cache ([Quastor teardown](https://blog.quastor.org/p/notion-decreased-latency-20-caching), [neetcode teardown](https://blog.neetcode.io/p/notion-uses-sqlite-caching)).
- **SiYuan**: one `.sy` **JSON AST file per document** (filename = timestamp + random suffix, e.g. `20260418142733-x7k9j2m.sy`), block = AST node with stable `ID`, `Type`, `Properties`; workspace = `data/<notebook-id>/*.sy` + `temp/siyuan.db` SQLite index (a `blocks` table powering search/queries) + `history/` versions + `repo/` encrypted sync snapshots; Markdown import/export via the Lute engine converts AST ⇄ Markdown bidirectionally ([SiYuan repo](https://github.com/siyuan-note/siyuan), [DeepWiki architecture](https://deepwiki.com/siyuan-note/siyuan)). SiYuan chose JSON-AST-on-disk *specifically* so block IDs survive edits — the feature Markdown storage can't provide.
- **Anytype**: objects described by the [any-block protocol](https://github.com/anyproto/any-block) (protobuf: `models.proto` for objects/blocks, `changes.proto` for CRDT changes, `events.proto`); local persistence via [any-store](https://github.com/anyproto/any-store) — "MongoDB-like query syntax with SQLite as the underlying storage engine," single SQLite file, ACID, WAL+fsync, auto-indexes; sync via any-sync (encrypted DAGs, P2P) ([Anytype export docs](https://doc.anytype.io/anytype-docs/advanced/data-and-security/import-export): exports as Markdown or Any-Block protobuf/JSON). Even a maximally decentralized, protobuf-native app landed on SQLite as the local document store.
- **AFFiNE / BlockSuite**: Yjs CRDT documents are the runtime truth ("block models use native JS data types" over a reactive Yjs layer); persistence and interchange happen through **block snapshots + transformers** — a JSON snapshot format with adapters to/from Markdown and HTML, and a ZipTransformer for full native snapshots (compressed Yjs update or JSON) ([BlockSuite repo](https://github.com/toeverything/blocksuite), [AFFiNE DeepWiki](https://deepwiki.com/toeverything/AFFiNE/2.4-document-import-system)). Pattern: CRDT binary for sync, JSON snapshot for interchange, Markdown as a lossy adapter — three explicit fidelity tiers.

### 6. "File over app" and local-first layering

[Steph Ango's "File over app"](https://stephango.com/file-over-app): "if you want to create digital artifacts that last, they must be files you can control, in formats that are easy to retrieve and read... If you want your writing to still be readable on a computer from the 2060s or 2160s, it's important that your notes can be read on a computer from the 1960s." Tool makers should assume their app will die and design the files to outlive it — Obsidian itself is built on this premise (plain files, no proprietary DB). This is the philosophical contract our storage layer must honor: **the file tree alone, opened in any text editor, must be a complete, comprehensible copy of the user's content.**

[Ink & Switch's local-first essay](https://www.inkandswitch.com/essay/local-first/) adds the systems view: seven ideals (no spinners, multi-device, offline, collaboration, the Long Now, privacy, user control); the local replica is "the primary copy... servers still exist, but they hold secondary copies"; plain files excel at longevity and third-party tooling, while CRDTs supply the merge layer files alone can't. Combined with the §5 survey, the industry-converged layering is:

1. **Canonical structured model** (JSON blocks / CRDT) — identity, order, full fidelity.
2. **Plain-text file projection** (Markdown + CSV + YAML) — durability, git, human access, "file over app."
3. **SQLite** — derived index/cache (search, backlinks, database views), rebuildable at any time.
4. *(later)* **CRDT change log** for sync — which is a property of the canonical layer, not of the text projection.

No shipping product uses the Markdown itself as the collaborative/canonical model; every one that offers Markdown treats it as a projection or adapter.

## Pitfalls

1. **Don't make lossy Markdown the canonical store.** Notion's export teardown shows what dies when structure lives only in Markdown: toggles flatten, views/formulas/relations vanish, IDs leak into filenames. SiYuan abandoned Markdown storage to keep block IDs stable. Markdown is a projection surface, not a database.
2. **Don't put machine JSON where humans edit** (Gutenberg's tax): comment-embedded JSON is breakable by hand-edits and creates dual-representation drift between attributes and rendered content. Keep the text projection human-safe; keep exact data in the canonical layer. If attributes must appear in text, use small, visible, forgiving syntax (`{key=val}`), not escaped JSON blobs.
3. **Don't encode toggles/columns as raw HTML if Obsidian matters**: "Obsidian does not render Markdown syntax inside HTML elements" — a `<details>` toggle turns its interior into dead text in Obsidian. Use foldable callouts (`> [!toggle]-`) and directive containers instead.
4. **Don't export relations as bare UUIDs or UUID-suffixed filenames** — Notion's most-hated export behavior; also breaks Windows path limits. Human-readable filenames + wikilinks, IDs kept in frontmatter.
5. **Don't export computed values as if they were data** without marking them: Notion freezes formulas/rollups to "last computed value, not their logic." Store the formula source in the view/schema file; treat any materialized value in CSV as cache.
6. **Don't let multiple writers touch one SQLite file from multiple contexts** — Notion corrupted browser-side databases with multi-tab writes and had to build single-writer election via SharedWorker + Web Locks. Single-writer discipline (or WAL + one writer process) from day one.
7. **Don't pick MDX for storage** — it crashes on invalid syntax, requires a JS toolchain to even read semantically, and mixes forgiving and unforgiving grammars.
8. **Don't invent a bespoke container syntax** when `:::` directives + `{attrs}` (Pandoc/Djot/markdown-it/remark-directive convergence) and `> [!type]` callouts (Obsidian/GitHub convergence) already exist — unknown-type fallback behavior (render contents anyway) is the property to preserve.
9. **Don't ship an exporter that references live/signed URLs** — Notion exports contain asset links that "quietly 403 later." Materialize every asset into the export.
10. **Don't conflate the sync problem with the storage problem**: CRDT/sync state (AFFiNE's Yjs binary, Anytype's change DAGs) is a separate, non-human-readable layer. Keeping it out of the text projection is what lets the projection stay clean; keeping the canonical model deterministic is what lets sync be added later.
11. **Don't treat "readable without the tool" as satisfied by JSON dumps.** Anytype exports protobuf/JSON that needed a community LLM-assisted script to become readable Markdown ([AnyBlock-To-Markdown](https://github.com/jfcostello/AnyBlock-To-Markdown)) — that fails the file-over-app test even though it's technically "open."

## Recommendations for our editor

**R1. Three explicit layers, with fidelity contracts:**

```
┌────────────────────────────────────────────────────────────┐
│ L0 CANONICAL — JSON block documents (source of truth)      │
│  one .json per page: {id, type, props, children[]} tree    │
│  + collection schema & view definitions as data            │
│  100% fidelity; versioned schema; CRDT-ready (stable IDs,  │
│  ordered children)                                         │
├────────────────────────────────────────────────────────────┤
│ L1 PROJECTION — Markdown + CSV + YAML (human/git layer)    │
│  one .md per page (frontmatter + Obsidian-flavored body)   │
│  one folder per database: rows as .md-with-frontmatter     │
│    (Notion-style) AND/OR rows.csv (spreadsheet-style),     │
│    views as a .base-compatible YAML file                   │
│  ~95% fidelity, defined loss list, always regenerable      │
│  from L0; re-importable with known degradations            │
├────────────────────────────────────────────────────────────┤
│ L2 DERIVED — SQLite (never authoritative, delete-safe)     │
│  pages/blocks tables (JSONB props), links/backlinks,       │
│  FTS5 index, materialized database-view row sets           │
│  0 information of its own; rebuilt by full scan of L0      │
└────────────────────────────────────────────────────────────┘
```

**R2. Canonical schema (L0)** follows the Notion/SiYuan consensus: block = `{id: uuid, type: string, props: object, children: [id...]}` stored as a per-page JSON tree file (SiYuan-style one-file-per-page keeps git diffs page-scoped and rebuild cheap). Views are data, not rendering: model databases as `collection` (schema: typed properties incl. formula *source*) + `view` records (filter/sort/group/limit), mirroring Notion's `collection`/`collection_view` split.

**R3. Markdown projection (L1) = Obsidian Flavored Markdown + `:::` directives**, chosen construct by construct for graceful degradation:
- callouts → `> [!type]` (degrades to blockquote everywhere);
- toggles → foldable callout `> [!toggle]- Title` (works in Obsidian, degrades to quote), *not* `<details>`;
- columns → `::: columns` / `::: column {width=0.5}` fenced directives (unknown-directive fallback: content renders sequentially — exactly Notion's flatten behavior, but recoverable);
- embeds/media → `![alt](path)` when possible, else `::: embed {url=...}`;
- page links → `[[wikilinks]]` with human filenames; block IDs only where needed via trailing `^id` (Obsidian-compatible);
- page/row properties → YAML frontmatter using Obsidian's six property types, page `id` in frontmatter (never in the filename);
- synced blocks → materialized copy + `{synced-from=id}` attribute.
- **Never require JSON blobs or HTML in the .md files.**
- Fidelity boundary, stated in the docs: L1 loses presentation minutiae (colors beyond an attribute hint, exact column pixel widths), synced-block liveness, and CRDT history — and nothing else. Anything else that can't be expressed must get a directive, not be dropped.

**R4. Databases in L1**: default to **one .md file per row** (frontmatter = properties, body = the row's page content) + a **`.base`-compatible YAML view file** — this is bidirectionally Obsidian-Bases-native and makes "open the vault in Obsidian" a real feature, not an import. Emit `rows.csv` additionally as a spreadsheet-facing convenience export (computed columns included but marked as materialized). Store formula *source* in the schema/view YAML; never only the computed value.

**R5. SQLite (L2)** is an optional, per-workspace cache: WAL mode, single writer, JSONB props column, expression indexes on `type`/property paths, FTS5 external-content index over block text, a `links(src_block, dst_page, dst_block)` table for backlinks, and materialized view-result tables for large database views. A `schema_version` + full-rebuild-from-L0 path must exist from day one (this is also the recovery story for any corruption). In-browser builds can reuse the same schema over WASM+OPFS later; adopt Notion's single-active-writer-tab pattern if/when we go multi-tab.

**R6. Direction of authority is one-way per edit**: editor writes L0, L0 regenerates L1 files and incrementally updates L2. External edits to L1 (user edits the .md in vim/Obsidian) are detected (mtime/hash) and *imported* into L0 through the Markdown parser — same code path as Notion-import, with known-degradation semantics and IDs preserved via frontmatter/`^id`. This avoids Gutenberg's dual-truth drift: at any instant exactly one layer is being treated as input.
- `ponytail:` note for the build phase: ship L0+L1 first; L2 SQLite only when search/db-views need it — it's derived, so adding it later costs nothing architecturally.

**R7. Interop endpoints to build against**: Notion Enhanced Markdown (API import/export — tag set documented above), Notion ZIP export (import path: handle UUID filenames, CSV databases, flattened toggles), Obsidian vault (L1 *is* one), Djot (optional clean export; borrow its `{attr}` syntax now so the mapping is trivial later).

**R8. Honor file-over-app as an acceptance test**: delete the app, open the workspace folder in a text editor — every page readable, every database row readable, every view definition inspectable, every asset present locally. If any content exists only in SQLite or only in a binary blob, that's a bug.

## Sources

- [The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion) — Notion engineering
- [How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) — Notion engineering
- [Export your Notion content](https://www.notion.com/help/export-your-content) — Notion Help
- [Enhanced markdown format](https://developers.notion.com/guides/data-apis/enhanced-markdown) — Notion Developers
- [Notion export limitations (2026): what travels, what breaks](https://raccoon.page/blog/notion-export-limitations/) — Raccoon Page
- [What Notion's Export Contains (and Silently Leaves Behind)](https://restora.cc/blog/what-notion-export-leaves-behind) — Restora
- [Notion's Markdown Export Quirks](https://mdstill.com/blog/notion-markdown-export-quirks) — mdstill
- [Export Notion to Markdown](https://notionbackups.com/guides/export-notion-to-markdown) — Notion Backups
- [How Notion Decreased Latency by 20% with Caching](https://blog.quastor.org/p/notion-decreased-latency-20-caching) — Quastor
- [How Notion uses SQLite for Caching](https://blog.neetcode.io/p/notion-uses-sqlite-caching) — neetcode
- [GFM Spec](https://github.github.com/gfm/) — GitHub
- [Pandoc User's Guide (fenced_divs, bracketed_spans, yaml_metadata_block)](https://pandoc.org/MANUAL.html) — Pandoc
- [markdown-it-container](https://github.com/markdown-it/markdown-it-container) — markdown-it
- [Djot README](https://github.com/jgm/djot/blob/main/README.md) — jgm/djot
- [List of djot implementations](https://github.com/jgm/djot/discussions/265) — jgm/djot
- [What is MDX?](https://mdxjs.com/docs/what-is-mdx/) — MDX docs
- [Gutenberg posts aren't HTML…](https://fluffyandflakey.blog/2017/09/04/gutenberg-posts-arent-html/) — Dennis Snell
- [Gutenberg block serializer](https://github.com/WordPress/gutenberg/blob/774713c0467779a9651983ec96609a6637811132/packages/blocks/src/api/serializer.js) — WordPress/gutenberg
- [Block Attributes — Block Editor Handbook](https://developer.wordpress.org/block-editor/developers/block-api/block-attributes) — WordPress
- [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown) — Obsidian Help
- [Internal links](https://obsidian.md/help/links) — Obsidian Help
- [Callouts](https://obsidian.md/help/callouts) — Obsidian Help
- [Properties](https://obsidian.md/help/properties) — Obsidian Help
- [Bases syntax](https://obsidian.md/help/bases/syntax) — Obsidian Help
- [Bases views](https://obsidian.md/help/bases/views) — Obsidian Help
- [Obsidian Roadmap](https://obsidian.md/roadmap/) — Obsidian
- [How I Turned 20,000 Notes Into Live Dashboards With Obsidian Bases](https://www.dsebastien.net/how-i-turned-20-000-notes-into-live-dashboards-with-obsidian-bases/) — dsebastien.net
- [Obsidian Bases: The Complete Guide to Database Views (2026)](https://got.md/obsidian-bases/) — got.md
- [File over app](https://stephango.com/file-over-app) — Steph Ango
- [Local-first software](https://www.inkandswitch.com/essay/local-first/) — Ink & Switch
- [SQLite As An Application File Format](https://www.sqlite.org/appfileformat.html) — SQLite
- [SQLite FTS5 Extension](https://www.sqlite.org/fts5.html) — SQLite
- [SQLite Release History (JSONB, FTS5 contentless-delete)](https://sqlite.org/changes.html) — SQLite
- [Write-Ahead Logging](https://www.sqlite.org/wal.html) — SQLite
- [SQLite 3.51.0 release notes](https://www.x-cmd.com/blog/251108/) — x-cmd blog
- [SiYuan](https://github.com/siyuan-note/siyuan) — siyuan-note
- [SiYuan architecture](https://deepwiki.com/siyuan-note/siyuan) — DeepWiki
- [any-block protocol](https://github.com/anyproto/any-block) — anyproto
- [any-store](https://github.com/anyproto/any-store) — anyproto
- [Anytype Import & Export docs](https://doc.anytype.io/anytype-docs/advanced/data-and-security/import-export) — Anytype
- [AnyBlock-To-Markdown](https://github.com/jfcostello/AnyBlock-To-Markdown) — jfcostello
- [BlockSuite](https://github.com/toeverything/blocksuite) — toeverything
- [AFFiNE Document Import System](https://deepwiki.com/toeverything/AFFiNE/2.4-document-import-system) — DeepWiki
