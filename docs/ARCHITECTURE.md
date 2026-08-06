# Architecture

Design-phase document. Every claim here traces back to a research note in
`docs/research/` (Notion internals, contenteditable, ProseMirror/Lexical/Slate,
Gutenberg/Editor.js/BlockNote/TipTap, storage, TanStack, hard interactions,
CRDT/native futures). §11 records the decisions where the research conflicted;
§12 records what is still unknown.

---

## 1. Principles

- **Model-first.** The DOM is never the source of truth (Santos' three broken
  axioms of contenteditable). The canonical document is a typed JSON block
  tree; everything renderable is a projection.
- **Operations all the way down.** Every mutation — keystroke to block move —
  is a named, serializable, invertible operation batched into a transaction and
  applied by one reducer. Undo, plugins, persistence, tests, and future sync
  all consume this single boundary.
- **Three layers, enforced.** Headless core (zero DOM) → one vanilla DOM view →
  thin framework mounts. Persistence packages depend on core only. Adapter
  dependency lists are asserted in CI.
- **Local-first from commit one.** Single-writer local store, transaction
  queue, optimistic apply. Notion waited 9 years to retrofit this.
- **CRDT-shaped, CRDT-free.** Stable IDs, op-shaped mutations, no persisted
  integer offsets. No CRDT dependency until the collaboration phase.
- **Schema stability outranks API stability.** The persisted document format
  and op JSON are versioned and frozen earliest — they are the public contract
  (the "readable without the tool" promise), even while editor APIs churn.

## 2. Document model

### 2.1 Block

```ts
type BlockId = string; // UUIDv7, client-generated, never semantic or positional

interface Block {
  id: BlockId;
  type: string;              // 'paragraph' | 'heading' | 'toggle' | ...
  version: number;           // block-type schema version, for migrations
  props: Record<string, unknown>; // open map; unknown keys preserved
  children: BlockId[];       // ordered render tree
  parentId: BlockId | null;  // maintained inverse pointer (validated invariant)
}
```

- **Runtime shape: flat `Map<BlockId, Block>`** (Lexical's EditorState shape
  holding Notion's five attributes). Immutable snapshots, per-block
  copy-on-write, a dirty-block set per transaction drives the reconciler.
- **At-rest shape: one nested JSON tree file per page** (SiYuan-style,
  git-diff-scoped). Same model, different serialization — flat in memory,
  nested on disk.
- `children` is the render tree; `parentId` exists because links and future
  transclusion make the document a graph (Notion's lesson: walking child arrays
  upward is ambiguous and slow).
- **Everything is a block, pages included.** Indentation is structural
  reparenting.
- **"Turn into" is non-destructive:** changing `type` never touches `props` or
  `children`; renderers ignore props they don't use.
- **Soft delete:** tombstones, not removal — feeds trash now, sync later.

### 2.2 Inline rich text

```ts
type RichText = Run[];
interface Run { text: string; marks?: Mark[] }
interface Mark { type: 'bold'|'italic'|'underline'|'strike'|'code'|'link'|'color'|'mention'; attrs?: {...} }
```

- Flat run arrays with mark **sets** per run (Notion/ProseMirror style). No
  nested mark tree, no offset-based spans, **no HTML strings in props, ever**.
- Closed mark set for v1: bold, italic, underline, strike, code, link, color,
  background (highlight), mention (page/date). Equation and comment-anchor
  later.
- **Colours are palette names, never raw CSS.** Both marks (`color`,
  `background`) and block props (`color`, `backgroundColor`) persist a name
  from the closed palette in `dom/src/colors.ts`. That keeps documents
  themeable (dark mode remaps the palette), keeps projections meaningful
  (the static renderer emits classes, not frozen values), and stops arbitrary
  CSS from entering the model through a colour picker.
- Each mark type declares Peritext expansion semantics (bold expands at
  boundaries, links do not) — dormant metadata until CRDTs, cheap to declare now.
- **Coordinate system: `(blockId, offset)`**, offsets in UTF-16 code units.
  Offsets live only in op payloads and ephemeral selection; anything persisted
  (comments, deep links) anchors to identities, never integers. Grapheme-safe
  boundary handling is an open question (§12).

### 2.3 Columns

`columnList → column(widthRatio) → any block except column`. Ordinary blocks in
the core schema — every system that has columns converged on this, and
BlockNote gating it behind GPL is our differentiation opening. Invariants
(min 2 columns, ratios sum to 1) enforced by the schema; **wrapper garbage
collection** (dissolving emptied column/columnList) is a reducer normalization
rule, not UI code.

### 2.4 Pages, links, mentions

Three distinct constructs, never conflated: sub-page (block in the tree),
link-to-page (alias block), inline mention (rich-text span resolving the live
title). **Backlinks are a derived index over mentions,** never authored data.

### 2.5 Databases (phase 3, modeled now)

Four separate record kinds, so linked views and multiple views per source are
free and no Notion-style breaking migration is ever needed:

1. **view block** — placement in a page
2. **view** — layout (table/board/list/gallery) + filters/sorts/groups
3. **schema** — typed properties, including formula *source* (computed values
   are cache, marked as such)
4. **rows** — full page blocks

## 3. Change pipeline

```
DOM events → typed commands (priority chain, return-true-stops) 
           → Transaction { ops[], inverseOps[], selectionBefore/After }
           → per-block schema validation at apply (never post-hoc normalization)
           → commit: swap snapshot, emit dirty set
           → reconciler + listeners + persistence
```

**Closed op set (7):** `insertBlock`, `deleteBlock`,
`moveBlock(id, parent, afterSibling)`, `setProps`, `insertText`, `deleteText`,
`formatText`. Moves are intent (parent + after-sibling ID), never
delete+reinsert and never fractional indexes — the two known concurrency traps.
Split/merge are composite transactions of these primitives, with
ProseMirror's command semantics (Enter: newlineInCode → createParagraphNear →
liftEmptyBlock → splitBlock; Backspace: deleteSelection → joinBackward →
selectNodeBackward).

**History = inverse-op stacks,** not snapshots (snapshot undo dead-ends at
collab). Entries store `{inverseOps, selectionBookmark (blockId+offset),
groupId}`. Coalescing: adjacent text ops within ~500 ms merge; hard break on
structural ops, selection moves, focus loss, paste, and IME composition end.
`addToHistory:false` escape hatch for programmatic/remote transactions.
Ephemeral overlay state (search highlights, cursors) never enters the document
or history.

**Schema-less normalization is banned** (Slate's infinite-loop tarpit):
validation happens at op-apply time against the declared schema; invalid
documents are unrepresentable.

## 4. Block schema registry

The single extension point. A block spec is a declarative, JSON-serializable
manifest (Gutenberg `block.json` spirit + BlockNote type inference) so a future
Swift editor can consume the same registry:

```ts
interface BlockSpec<P> {
  type: string;
  version: number;
  migrate?: (oldProps: unknown, fromVersion: number) => P;  // pure, on JSON, at load
  props: PropsSchema<P>;          // typed, defaults, enums
  allowedChildren?: ContentRule;  // grammar: nesting/column invariants live in data
  inlineContent?: boolean;
  // four separated concerns:
  render(block, ctx): DomSpec;        // interactive edit view (dom package)
  renderStatic?(block): string;       // schema → HTML/MD without an editor
  parse?: PasteRule[];                // import/paste matching
  commands?, keymap?, slashMenu?: {keywords, group, icon};
}
```

Versioned pure `migrate` on JSON at document load solves Gutenberg's
deprecation treadmill without its markup-replay archaeology. Unknown types and
unknown props round-trip untouched.

Plugin shape (core): `{ commands?, keymap?, blockSpecs?, overlays?(state),
state?: reducer over transactions, domEventHandlers? }` — ProseMirror's
reducer plugin-state married to Lexical's priority command dispatch. Zero
framework code in core.

## 5. Editable surface & input

**Decision (D1, §11): per-block contenteditable leaves** — one small
`contenteditable="plaintext-only"` element per text block (Baseline since
2025; the browser physically cannot inject rich markup), composed around
`contenteditable=false` void wrappers for media/embeds. Verified as Notion's
actual production DOM; independently chosen by BlockSuite ("significantly
reduces complexity"); avoids matching prosemirror-view's decade of
document-wide reconciler workarounds. Complex widgets (database views) live
*around* editables, never inside an editable root.

Notion's 5-year cross-block-selection retrofit was caused by the missing
document-level selection **model**, not by per-block DOM per se — so we build
that model from day one (§5.2) and keep the DOM decision swappable via a
Phase 0 spike (ROADMAP).

### 5.1 The InlineEditor leaf module

All browser warfare is quarantined in one dependency-free module:

- **Dual input path:** cancelable `beforeinput` + `getTargetRanges()` as the
  primary path; MutationObserver reconciliation as the mandatory fallback
  (IME composition events are non-cancelable by spec; Android GBoard actively
  lies; autofill/spellcheck may fire nothing).
- **The ironclad IME rule:** never mutate the DOM mid-composition. Freeze
  reconciliation at `compositionstart`, record mutations, flush to the model at
  `compositionend`. History never splits a composition.
- Let the browser own caret physics (bidi, graphemes, line wrap) inside a
  leaf; intercept only boundary keys (arrows at leaf edges preserving goal-X,
  Enter/Backspace for split/merge).
- `preventDefault` kills native undo → model-level undo is table stakes (§3).
- Extension hardening: `data-gramm=false` etc., revert unrecognized foreign
  mutations by re-rendering the leaf from the model; never persist unknown
  nodes.
- EditContext API is the designed successor but Chromium-only in 2026; the
  leaf-module boundary makes that migration a local swap later.
- The browser/IME test matrix (Chrome/Firefox/Safari desktop, Android
  Chrome + GBoard + Samsung Keyboard, iOS Safari, CJK IMEs, mid-word
  backspace) is a first-class artifact from the first prototype.

### 5.2 Selection

First-class core state, a tagged union with two modes (the Notion contract):

- `TextSelection {anchor: (blockId, offset), head: (blockId, offset)}` —
  cross-block capable in the model **and in the UI** (D3). Every operation on
  a range goes through `resolveTextRange` in core, so cross-block delete,
  format and copy are defined in exactly one place: the tail of the first
  block and the head of the last are covered, blocks in between fully, and
  deleting merges the remainder upward as any editor would.
- `BlockSelection {anchor, head}` — Esc selects current block / Enter
  re-enters text; arrows & Shift+arrows navigate/extend; Cmd+A escalates;
  Shift+Click ranges; Cmd/Alt+Shift+Click toggles; Cmd+Shift+arrows move
  blocks; margin rubber-band select.
- Plus a GapCursor equivalent for positions with no text (before an image).

## 6. View layer & chrome

`packages/dom` is **the** editor view (prosemirror-view precedent): block
structure, wrapper elements, editable leaves, keymaps, clipboard, drag,
overlays. Framework adapters never re-implement it.

- **Slot contract (explicit, day one):** dom owns block structure and
  editable regions; custom-block components own only leaf interiors behind a
  stable wrapper tag, mounted via portals. (Where TipTap accumulated its
  sharpest caveats.)
- **Overlay/decoration API** keyed by `blockId` + optional intra-block range +
  widget positions, supplied by plugins per commit, never persisted, never in
  history. BlockId keying kills ProseMirror's DecorationSet mapping cost for
  untouched blocks.
- **Chrome** (slash menu, drag handle, selection toolbar, turn-into) = headless
  controller stores in core + vanilla DOM renderers in dom, wrapped per
  framework (the query-devtools pattern). Every component replaceable.
- **Selection toolbar** (Medium/Notion): appears on a non-collapsed text
  selection, anchored to the selection rect and flipping when there is no room
  above. Every control cancels `mousedown`, so the toolbar never takes the
  selection it is acting on. Turn-into, the five inline formats, link, text
  colour and highlight.
- **Per-block-type menu actions** live in a registry
  (`dom/src/block-actions.ts`): a callout contributes "change icon", a code
  block its language list, an image its replace drop zone. The generic block
  menu never grows type-specific branches and custom blocks register their own
  without touching `controls.ts`.
- **UI primitives (`dom/src/ui/`),** shared by all chrome and exported for
  block authors: `position` (pure flip/clamp engine + `autoUpdate` live
  anchoring), `menu` (keyboard nav, outside-click/Escape dismissal, and it
  never steals keys from form controls inside custom entries), `tooltip`,
  `hover` (geometry-resolved hover zone with grace delay — floating chrome
  never kills the hover), `drag` (pointer drag session, D8), `ghost` (stacked
  drag preview with count badge, shared by block and board-card drag),
  `upload` (`pickFile`, `fileToDataUrl`, `createDropZone` — click, drop or
  paste a URL), `icon-picker` (emoji grid with diacritic-insensitive search
  plus a custom-image tab). Any new block reuses these rather than growing
  its own chrome.
- **Page geometry belongs to the editor, not the host app**
  (`EditorViewOptions.padding` / `maxWidth`). The view fills its container and
  centers the text column with padding rather than `max-width`, so the margins
  remain editor surface: rubber-band selection, click-to-place and drop
  targets all work out there (Word-like margins). Set them to `0` for a
  flush-to-the-edge embed.
- **All affordances are hover/focus-only** (handles, +, placeholders, sync
  halos). Always-visible chrome is why clones read as toys. Caret-only
  "Type / for commands" placeholder.
- **Performance:** per-block `content-visibility: auto` with
  `contain-intrinsic-size` from cached heights. **No document virtualization**
  (it breaks Ctrl+F, the a11y tree, and selection); virtualize only inside
  database views. Data layer loads async, never blocking first paint. Budget:
  60 fps scroll on a 10k-block page.

## 7. Clipboard & drag-and-drop

**Copy writes three formats** (custom MIME types don't survive the OS
clipboard portably): `text/html` carrying a base64 attribute with the lossless
schema slice + open-depth context (data-pm-slice/Figma pattern); `text/plain`
as **Markdown** (BlockNote precedent, matches our storage story); custom type
for same-origin fast path.

**Paste priority:** internal format → `vscode-editor-data` (code with language)
→ `text/markdown` → `text/html` (source-sniff Word `mso-*` / Google Docs
`docs-internal-guid` wrapper — not bold! — normalize per source, undo WebKit's
`&nbsp;` corruption) → `text/plain` (conservative Markdown heuristic) → Files.

**The schema is the sanitizer:** paste parses into whitelisted nodes/marks,
never `innerHTML` (pasted HTML is a real XSS vector). DOMPurify only for
raw-HTML embed blocks. A paste fixture corpus (Word, GDocs, Excel, VS Code,
Notion, web) is built early — paste is the highest-regression surface.
Cmd+Shift+V plain paste from day one.

**Drag is pointer-events, not HTML5 DnD** (native DnD: no touch initiation,
unstylable previews, no dragover data, broken auto-scroll — matches Notion's
observed choice): setPointerCapture, movement threshold, `elementsFromPoint`
hit-testing against block rects with hysteresis, own multi-block preview with
count badge, Escape cancels, built-in edge auto-scroll. Drop model:
`{targetBlockId, edge: before|after|inside|left|right}` where left/right
creates/joins column blocks — ordinary schema nesting, so undo/copy/export
degrade gracefully. Native drop listeners only for OS file drops. The vertical
blue guide is the *sole* column-creation UI.

## 8. Accessibility

Architecture, not audit (Gutenberg failed all 30 applicable WCAG 2.1 criteria
*after* shipping to a third of the web):

- **Navigation/Edit two-mode keyboard model — structurally the same state
  machine as block selection (§5.2).** One tab stop per document; arrows move
  between blocks; Enter/Escape switch modes.
- Every drag affordance has a menu/shortcut equivalent; the drag handle is
  also a menu button that can do everything drag does.
- `role=textbox aria-multiline` root, polite live-region announcements for
  block moves/type changes.
- NVDA + VoiceOver smoke tests from the first interactive prototype; external
  audit budgeted before 1.0; Tenon's 90 public Gutenberg issues mined as a
  free checklist.

## 9. Packages & monorepo

```
core        schema registry, block store, ops/transactions, commands,
            selection, history, controller stores. Zero DOM.
            Only runtime dep: @tanstack/store behind an injected
            ReactivityBindings contract (Table v9 pattern) — the contract
            doubles as the spec a Swift port mirrors.
  ↑
dom         the single contenteditable view: rendering, InlineEditor leaves,
            keymaps, clipboard, drag, overlays, default chrome renderers.
  ↑
react|vue|svelte   thin mounts: lifecycle + reactive projection
                   (@tanstack/*-store) + custom-block portal bridge.
                   Dependency list = {dom, @tanstack/x-store} exactly —
                   asserted in CI; a third dep means the feature belongs
                   one layer down.

markdown, sqlite, static-renderer   depend on core ONLY, never dom
                                    (preserves server/CLI/Swift/Obsidian paths).
blocks-*    schema entry (deps: core) + /dom renderer entry (deps: dom)
            split via subpath exports.
collab      (phase 5) CRDT behind the same store interface, optional peer.
```

Tooling, day one and minimal: pnpm workspaces, tsdown, **ESM-only**
(deletes the dual-format bug class), `sideEffects: false`, subpath exports,
Vitest + Playwright, publint --strict per package. Add when they hurt:
Changesets (first publish), size-limit budgets on core/dom, sherif/knip,
Nx as a dumb cached task graph (~6+ packages). `examples/vanilla` exists
**before** any framework example and CI-consumes the public API — vanilla as
the discouraged path is how it rots (BlockNote). Types: per-instance generics
parameterized by the registered schema; never global declaration merging.

## 10. Storage

Three layers with explicit fidelity contracts:

- **L0 — canonical.** One JSON block-tree file per page + workspace manifest.
  Sole source of truth. Stamped `schemaVersion`, additive-only evolution,
  unknown types/fields preserved.
- **L1 — human projection.** Obsidian Flavored Markdown by construction:
  callouts `> [!type]`, toggles as foldable callouts (never `<details>` —
  Obsidian renders no Markdown inside HTML), columns/embeds as `:::` directives
  with `{attrs}` (the converged convention with graceful unknown-type
  fallback), `[[wikilinks]]` with human filenames, page id/properties in YAML
  frontmatter, block IDs as trailing `^id`. **No JSON blobs or HTML in .md.**
  Databases: one .md per row (frontmatter = properties) + a `.base`-compatible
  YAML view file — an exported workspace opens natively in Obsidian — plus
  `rows.csv` convenience export with computed columns marked as materialized
  cache. ~95% fidelity with a *documented, tested* loss list (silent lossy
  export is Notion's most-resented behavior).
- **L2 — derived index.** SQLite: WAL, single writer, JSONB props, FTS5
  external-content search, links table for backlinks, materialized view
  results. Holds **zero unique information**, rebuildable by full L0 scan.
  Deferred until search/db-views need it.

**Authority flow:** exactly one layer is input at any instant. The editor
writes L0 → regenerates L1 → incrementally updates L2. External edits to L1
(Obsidian, vim) are detected (mtime/hash) and imported through the same parser
as Notion-import, preserving IDs via frontmatter/`^id`.

**Acceptance test:** with the app deleted, the workspace folder opened in a
text editor shows every page, row, view definition, and asset. Content that
exists only in SQLite or a binary blob is a bug.

Interop targets: Obsidian vaults (L1 *is* one), Notion ZIP import (UUID
filenames, CSV databases, flattened toggles), Notion Enhanced Markdown, Djot
`{attr}` syntax borrowed now to keep that export trivial.

## 11. Decisions

Where the research notes conflicted, resolved here:

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D1 | Per-block contenteditable vs single editable root | **Per-block `plaintext-only` leaves** + document-level selection model from day one; confirmed by Phase 0 spike (Android IME, screen readers, cross-block selection) | Notion's actual production DOM; BlockSuite chose it greenfield; single-root means matching PM's decade of monthly reconciler workarounds. Notion's 5-year retrofit pain came from the missing selection *model*, which we build up front |
| D2 | Build on ProseMirror vs from scratch | **From scratch, vanilla TS** — adopting PM's *ideas* (invertible ops, schema-at-apply, command chains) without the dependency | The project's raison d'être; per-block topology confines browser warfare to one leaf module instead of a document-wide reconciler, which is what makes from-scratch tractable; skipping PM's global position system removes its dominant complexity |
| D3 | Cross-block text selection | **Shipped: we drive the gesture, the browser paints the range** (`cross-block-selection.ts`). Full analysis in `docs/research/cross-block-selection.md` | The browser refuses to *create* a cross-host range from a gesture but happily *holds* one: `setBaseAndExtent` across leaves paints natively, measured in our editor. So we compute caret positions during the drag ourselves. Chosen over Gutenberg's container-`contentEditable` toggle (which needs every key blocked while on, plus a focus-restoration dance) and over a CSS Custom Highlight overlay (which paints pixels but is not a *selection*, so clipboard, IME and AT would all need re-implementing). **Known risk:** synthetic pointer handling is unreliable for iOS touch selection — Gutenberg hit this twice — so touch is expected to fall back to block selection until the device matrix says otherwise. Notion, for reference, uses a permanently editable page root; Gutenberg tried that in July 2026 and reverted it in August |
| D4 | Inline text representation | **Flat runs with mark sets**, no offset spans, no HTML strings | Offset spans contradict the no-persisted-integers rule; runs are Santos-proof, CRDT-ready, AttributedString-friendly |
| D5 | Flat map vs nested tree | **Both: flat `Map` at runtime, nested JSON per page at rest** | Not a real conflict — same model, two serializations; each optimal for its medium |
| D6 | Block ID format | **UUIDv7** | Time-ordered (SQLite index locality) yet still non-semantic/non-positional; creation time is not position |
| D7 | Markdown: one-way export vs re-importable | **Two-way with documented loss boundary**; L0 stays canonical | "Readable without the tool" + Obsidian interop are project goals; SiYuan/Notion prove markdown-as-database fails, so import goes through the parser into L0, IDs preserved |
| D8 | Drag & drop: external lib (Atlassian Pragmatic) vs in-house | **In-house pointer-events drag primitive** (`ui/drag.ts`); native DnD listeners only for OS file drops | Pragmatic builds on native HTML5 DnD, whose limits are exactly why we avoided it (no touch initiation, unstylable previews, no dragover data, broken auto-scroll — research: hard-interactions). Revisit only if OS-level drag interop becomes a requirement |

## 12. Open questions (tracked, not yet designed)

From the adversarial completeness review — each needs a design pass before its
phase begins:

1. **Storage runtime/platform.** Browser (OPFS/File System Access) vs
   Tauri/Electron vs CLI; atomic temp+rename writes, debounced saves, crash
   safety, watcher-based conflict handling.
2. **Binary asset pipeline.** Where blobs live across L0/L1/L2, content-hash
   dedup, reference counting/GC on delete+undo, sync later.
3. **The simple table block.** Cell model, row/col operations, cell-range
   selection, Tab/Enter navigation, spreadsheet clipboard round-trip.
   Historically among the hardest editor features; deliberately post-v1.
4. **Unicode correctness.** Grapheme clusters, surrogate pairs, ZWJ emoji,
   NFC/NFD, bidi — how splits/marks/selection avoid bisecting a perceived
   character despite UTF-16 offsets.
5. **Markdown parser/serializer engineering.** remark/mdast vs markdown-it vs
   custom; deterministic diff-stable serialization; ID-preserving re-import.
6. **Editor test automation.** Simulating IME composition/clipboard/drag in CI
   (Playwright/CDP limits), headless op-layer tests vs real-browser matrix,
   non-US layouts (AZERTY dead keys vs shortcut collisions).
7. **Touch/mobile interaction design.** Touch equivalent of hover chrome,
   selection handles, virtual-keyboard occlusion (visualViewport), long-press.
8. **Database evaluation engine.** Formula language, filter/sort/group
   evaluation, incremental rollup/relation recompute, CSV dialects.
