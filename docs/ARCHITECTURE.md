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

- **Runtime shape: a flat block store** (`BlockStore`, satisfied by `Map`) (Lexical's EditorState shape
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
  themeable — the DOM package resolves a name to `var(--nbe-color-<name>-…)`,
  so dark mode remaps the palette in CSS and no document is ever rewritten —
  keeps projections meaningful
  (the static renderer emits classes, not frozen values), and stops arbitrary
  CSS from entering the model through a colour picker.
- Each mark type declares Peritext expansion semantics in `core/src/marks.ts`
  (bold expands after, links and code do not). Declared for the CRDT phase —
  Loro's `configTextStyle` takes exactly this shape — but **not dormant**: it
  decides what the next typed character inherits, so without it typing after a
  link extended the link. Written here since the design phase and only actually
  built on 2026-08-07, when the phase 5 audit went looking for it.
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
- **Modifiers.** Command is the modifier on macOS and Control is the modifier
  everywhere else (`isMod`), rather than both everywhere — Control carries the
  system's own text keymap on a Mac (^A/^E/^K/^F/^B/^N/^P/^D) and every browser
  implements it inside a contenteditable, so claiming it broke all of them.
  Alt+arrows move a block and Shift+Alt+arrows copy it, aliasing Cmd+Shift and
  Cmd+D for anyone arriving from VS Code or PhpStorm. Cmd+Backspace deletes the
  block — Command only, since off a Mac Ctrl+Backspace is the platform's word
  delete and Escape then Backspace deletes the block there. Word and line
  deletes are honoured rather than blocked: Chromium
  reports no `getTargetRanges()` for them, so `prevWord`/`nextWord` (UAX #29)
  compute the boundary.
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
- **Two ways to configure a block, on purpose.** Rare or destructive actions
  live in the ⋮⋮ gutter menu via a registry (`dom/src/block-actions.ts`:
  callout icon, code language, image replace). Frequent, visual actions live
  in a **floating toolbar at the block's top-right on hover**
  (`dom/src/block-toolbar.ts`: an image's caption, alignment, size, download)
  — under the pointer, not two clicks deep. A registered plugin declares both
  in its `BlockView` (`actions`, `toolbar`, `toolbarPlacement`); the two
  module-global registries are what the types not yet extracted still use, and
  they are consulted only when no plugin owns the type.
- **Link hover card** (`dom/src/link-hover.ts`): hovering a link offers open /
  copy / edit / remove without selecting the text first; editing selects the
  link's exact range so the range commands apply to it.
- **Three block categories** (`blockCategory` in core), and every behavioural
  question follows from which one you have: `text` carries inline content so
  it owns a caret and is edited; `void` (image, divider, page link, database)
  has no caret, so a press on it is a **grab**, not an edit — it drags
  directly; `layout` (columns, page) is structure and is never a drag target.
  A type that is an exception to the last rule says so with
  `BlockSpec.standalone` — a table is a container *and* the unit you grab,
  while its rows and cells are neither — rather than being named in the gutter.
  A block that is part of the current block selection drags directly too, so a
  rubber-band selection is immediately reorderable without hunting for the
  handle.
- **One way to build an action control**: `ui/createActionButton`. It takes a
  mandatory `title` that becomes both the accessible name and the tooltip, and
  handles popover-toggle behaviour and selection preservation. Every surface
  goes through it — gutter, block toolbar, selection toolbar, link card,
  block-rendered affordances — so a control cannot ship without a label. This
  is a factory rather than a convention precisely because conventions get
  forgotten at the fortieth call site.
- **A block plugin may bring its own dependency, and the editor keeps none.**
  `@nbe/blocks-code` ships `lowlight`/`highlight.js`; `core` and `dom` are still
  at zero runtime dependencies, and a host that does not register the block
  does not download the grammars. It also brings its own *technique*: syntax
  colours are painted as `Range`s through the CSS Custom Highlight API rather
  than as markup in the leaf, so the caret, IME composition and the DOM→model
  reconciler never see them (`docs/research/syntax-highlighting.md`).
- **A block plugin can contribute editor-wide behaviour**, not only rendering:
  `BlockView.features` is the same `attach(view) => unbind` contract the
  editor's own features use, and a feature may add a `GestureRecognizer` so a
  contested press still has exactly one owner. That is deliberately *not* a raw
  DOM escape hatch (§ the research note on ProseMirror's frozen `nodeViews`):
  the table's hover chrome and its cell-rectangle selection are built from it,
  and nothing in `dom` knows they exist.
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
- **Chrome anchored to a block lives inside the editor**, not on
  `document.body` (`ui/position.ts#toContainerPoint`). The hover gutter and the
  per-block toolbar are positioned against `.nbe-editor`, which is the
  positioning context, and the horizontal padding reserves `--nbe-gutter-width`
  so the gutter has a margin to sit in. Mounted outside, three faults were
  possible at once and all three were reported together on 2026-08-07: it
  followed only the window's scroll and not the editor's, it was positioned
  once on hover and never updated, and it was placed outside the editor
  entirely when the host was narrower than the gutter. Inside, none of them
  can happen — it scrolls because it is part of what scrolls, it tracks its
  block because it is measured against the same box, and it cannot leave a box
  it lives in. Both carry `contenteditable="false"` and `data-nbe-ui`, since
  under a single-host topology that container *is* the editing host.
- **Floating chrome that must break out carries its own token scope**
  (`ui/portal.ts`). Menus,
  toolbars, the drag ghost, the drop indicator and the rubber band are mounted
  on `document.body` so nothing inside the editor can clip them — and so they
  inherit none of the design tokens, which are declared on the editor element.
  That was a hand-written list of eight component class names in `tokens.css`,
  and it drifted: measured 2026-08-07, the drop indicator and the drag ghost
  resolved `--nbe-accent-rgb` to nothing and painted `rgba(0, 0, 0, 0)`, so
  dragging showed *nothing at all*. One marker class replaces the list, applied
  where the element is mounted, and `test/portals.test.ts` fails the build on a
  raw `document.body.append` in the view layer.
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
observed choice): setPointerCapture, movement threshold, own multi-block
preview with count badge, Escape cancels, built-in edge auto-scroll.

**The drop target is geometry, not the DOM** (`dom/src/drop.ts`, reworked
2026-08-07). `resolveDrop(x, y, candidates, opts)` is a pure function over
rectangles — no DOM, no editor, no events — so how dragging *feels* is a set
of numbers under unit test rather than something you check by hand. It answers
`{id, edge}` where `edge` is `before | after | left | right`, and `left/right`
creates or joins a `columnList/column` structure: ordinary nested blocks, so
undo, copy and export degrade gracefully.

Two faults it exists to prevent, both reported as "the editor is unusable":

- **Dead zones.** The previous version asked `elementsFromPoint` what was under
  the cursor, which is the pitfall `docs/research/hard-interactions.md` §8
  names outright: margins, gaps and nested wrappers had no answer, so the
  indicator blinked out between every pair of blocks. Now every candidate is
  measured and the pointer resolves to the nearest one; `null` means the
  document is empty, nothing else.
- **A column band that ate the block.** The side zone was a quarter of the
  width clamped to 140px — **46% of a 612px block** — so aiming to reorder
  produced a column. It is now 12% clamped to 64px, leaving four fifths of the
  width to reordering, with hysteresis capped at a quarter of the block height
  (a constant 16px pushes the midpoint outside a 28px paragraph, which made
  "drop above" unreachable from below).

**Side drops are experimental and off** (`EditorViewOptions.columns`, default
`false`). Off, every drop is a reorder and the bands are neither drawn nor
tested for — columns remain reachable from the slash menu, and documents that
already have them still render. The default is a judgement about the gesture,
not about columns: one drag answering with two different documents ("moved
below" vs. "now a two-column layout") is a miss the user cannot undo by aiming
better, and the band tuning above is what it costs to make the two coexist.
Until that reads as reliable, layout is something you ask for, not something a
drag can produce by accident.

**The indicator is a 2px line with a head dot**, horizontal between blocks and
vertical against the edge that would become a column — Atlassian's documented
convention, and what Notion shows. It replaced a translucent 140px slab that
read as "this area is selected" rather than "it lands here". Position eases,
size snaps: animating both made the line morph through fat rectangles when it
flipped orientation.

Drop model: `{targetBlockId, edge}`. Native drop listeners only for OS file
drops. The vertical line is the *sole* column-creation UI.

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

markdown, workspace, static-renderer   depend on core ONLY, never dom
                                       (preserves server/CLI/Swift/Obsidian paths).
workspace   the notes app's model: a page tree derived from sub_page blocks,
            search, backlinks, and the WorkspaceStorage seam (memory here,
            /idb in the browser, files on a backend). Zero DOM.
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
- **L2 — derived index.** Holds **zero unique information**, rebuildable by a
  full L0 scan. Its *implementation depends on the runtime*, and this is a
  correction to an earlier reading of this document (2026-08-07):

  - **In the browser**, L2 is whatever the browser provides — IndexedDB or
    OPFS. SQLite/WASM is explicitly **not** the browser path: it would mean
    shipping a WASM binary and a single-writer worker to rebuild something the
    platform already stores, for a cache that by definition holds nothing
    unique.
  - **On a server, desktop or CLI runtime**, where the workspace is real files
    on a real filesystem, L2 *is* SQLite: WAL, single writer, JSONB props,
    FTS5 external-content search, a links table for backlinks, materialized
    view results.

  Both satisfy the same contract, which is why the choice can be deferred to
  the runtime rather than baked into the model: an index that holds nothing
  unique can be swapped, or absent, without the document layer noticing.

**The frontmatter is the document's own metadata layer** (added 2026-08-10,
`packages/markdown/src/frontmatter.ts`). Everything that is *about* a note
rather than *in* it goes in the YAML header, under two rules that make it safe
to share a file with a vault, a static site generator and whatever else already
writes there:

- **A key we did not touch is re-emitted verbatim** — copied, not re-serialized,
  so a hand-written `tags:` list, its comments and its alignment survive a save
  by this editor. Three ad-hoc readers used to grep the header for the two keys
  their writer had written (`vault.ts`, `collections.ts`, the Obsidian host);
  each one dropped everything else on the way through.
- **Everything this editor owns hangs under one key, `nbe`.** A note's own
  `title`, `tags` or `comments` can never collide with ours, and a plugin adding
  a section (`Frontmatter.setSection`) merges rather than replaces, so two
  plugins cannot clobber each other. Structured values are written as JSON,
  which is YAML flow style — valid to every parser, read back without carrying a
  YAML implementation.

Two things moved there. **Comment threads**, which were a `%%carnet-comments%%`
block at the end of the note — invisible when rendered, but prose all the same:
it moved when the note was appended to, the word count counted it, search
matched inside it. And **the title a filename cannot hold**: a note called
« Réunion : 2026/07 » is the file `Réunion 2026 07.md` with `title: "Réunion :
2026/07"` in its header, because a vault names a note `<Titre>.md` and resolves
`[[wikilinks]]` by that name. The property is written only when the two differ,
so an ordinary note stays ordinary.

**Authority flow:** exactly one layer is input at any instant. The editor
writes L0 → regenerates L1 → incrementally updates L2. External edits to L1
(Obsidian, vim) are detected (mtime/hash) and imported through the same parser
as Notion-import, preserving IDs via frontmatter/`^id`.

**Acceptance test:** with the app deleted, the workspace folder opened in a
text editor shows every page, row, view definition, and asset. Content that
exists only in the derived index — whatever that runtime's index happens to be
— or only inside a binary blob, is a bug.

Interop targets, all shipped 2026-08-07 in `@nbe/workspace`: Obsidian vaults
(L1 *is* one — `/vault` exports and re-imports one, assets included), Notion
ZIP import (`/notion`: UUID filenames become page ids, folders become the
tree, CSV databases become collections), and Notion Enhanced Markdown
(`/enhanced`: `<callout>`, `<details>`, `<columns>`, page and mention tags).
Djot `{attr}` syntax is borrowed to keep that export trivial.

Two honest limits carried by the importers rather than hidden: their fixtures
are written from the *documented* shape of each format, not captured from a
real Notion workspace (`docs/TESTING.md` says what to check once), and a CSV
cannot yield a relation, a rollup or a formula because it never encoded one —
Notion does not put views or formulas in Markdown either.

## 11. Decisions

Where the research notes conflicted, resolved here:

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D1 | Per-block contenteditable vs single editable root | **Per-block `plaintext-only` leaves** + document-level selection model from day one; confirmed by Phase 0 spike (Android IME, screen readers, cross-block selection) | Notion's actual production DOM; BlockSuite chose it greenfield; single-root means matching PM's decade of monthly reconciler workarounds. Notion's 5-year retrofit pain came from the missing selection *model*, which we build up front |
| D2 | Build on ProseMirror vs from scratch | **From scratch, vanilla TS** — adopting PM's *ideas* (invertible ops, schema-at-apply, command chains) without the dependency | The project's raison d'être; per-block topology confines browser warfare to one leaf module instead of a document-wide reconciler, which is what makes from-scratch tractable; skipping PM's global position system removes its dominant complexity |
| D3 | Cross-block text selection | **Amended 2026-08-07.** A selection spans blocks, but the *browser* does not hold it — the model does, and the CSS Custom Highlight API paints it (`cross-block-highlight.ts`) | The original claim was that a `Selection` may span several `contenteditable` hosts. **Measured false in Chromium 150 headed and 151 headless** (`e2e/selection-topology.spec.ts`): it is clamped to the host it starts in — for `setBaseAndExtent` *and* `addRange`, `plaintext-only` *and* `true`, focused or not. The same range spans freely when the leaves are not editable, or under one editable root, so the constraint is the **editing-host boundary**. Temporary toggles of editability were measured too and all lose the range on restore. What survived is the distinction between the two APIs: a plain **`Range`** spans hosts freely; only `Selection` is constrained. So the model carries the range — it always could (§5.2) — and a `Highlight` paints it. This kept D1: every range command already went through `resolveTextRange`, so delete, format and copy were defined on the model rather than the DOM and needed no change. **Cost:** a highlight is not a selection, so a screen reader does not announce it as one, and find-on-page does not extend it (`docs/TESTING.md`). **Verified by** `e2e/cross-block-selection.spec.ts`: drag, shift-click, type-over, delete, bold and copy, plus the release path |
| D4 | Inline text representation | **Flat runs with mark sets**, no offset spans, no HTML strings | Offset spans contradict the no-persisted-integers rule; runs are Santos-proof, CRDT-ready, AttributedString-friendly |
| D5 | Flat map vs nested tree | **Both: flat `Map` at runtime, nested JSON per page at rest** | Not a real conflict — same model, two serializations; each optimal for its medium |
| D6 | Block ID format | **UUIDv7 with a monotonic counter** (amended 2026-08-08) | Time-ordered (SQLite index locality) yet still non-semantic/non-positional; creation time is not position. **The original implementation was only ordered *across* milliseconds**: everything after the timestamp was random, so ids minted in the same millisecond sorted arbitrarily — measured, two hundred in a loop came back shuffled. That was silently wrong for anything relying on the order, and `workspace/src/database.ts` does: it sorts a collection's rows by id and calls it creation order, while `importRows` creates them in a tight loop. Fixed with the dedicated counter RFC 9562 §6.2 specifies, in the twelve bits after the version nibble, seeded into the lower half so a burst has room. **Verified by** `packages/core/test/decisions.test.ts`, including ten thousand ids minted as fast as possible |
| D7 | Markdown: one-way export vs re-importable | **Two-way with documented loss boundary**; L0 stays canonical | "Readable without the tool" + Obsidian interop are project goals; SiYuan/Notion prove markdown-as-database fails, so import goes through the parser into L0, IDs preserved. **The loss is source layout, and only that** (amended 2026-08-07): hand-wrapping is folded away because a soft break is not content, leading indentation is normalised, nested levels are re-emitted at four spaces, and consecutive numbered items are renumbered `1. 2. 3.` rather than the `1. 1. 1.` CommonMark also accepts. The property under test is therefore **idempotence**, not equality with the source: `parse → print` may differ from the input once and never again. `test/docs-roundtrip.test.ts` runs that over this repository's own documentation, which is where the wrapping bug was found. **Amended 2026-08-09: the props are no longer part of the loss.** A file's mime type, an image's width, a toggle's toggle-ness and a colour on any block had no syntax to be written in, so each save dropped them — and a toggle came back a bullet, a file card came back a paragraph. A block type now declares in its spec what its line already spells (`BlockSpec.spelledProps`, `markdownAmbiguous`), and `@nbe/markdown` writes everything else into an invisible `<!-- nbe:type {…} -->` trailer on that line, reading it back the same way. Declared once per type rather than handled per projection, so a prop added later — or a prop of a plugin's own block — is carried without either side learning about it. The line stays the line every other Markdown tool renders; `blocksToMarkdown(…, { markers: false })` drops the trailers for text going somewhere that is not this editor |
| D8 | Drag & drop: external lib (Atlassian Pragmatic) vs in-house | **In-house pointer-events drag primitive** (`ui/drag.ts`); native DnD listeners only for OS file drops | Pragmatic builds on native HTML5 DnD, whose limits are exactly why we avoided it (no touch initiation, unstylable previews, no dragover data, broken auto-scroll — research: hard-interactions). Revisit only if OS-level drag interop becomes a requirement |
| D9 | Peer-to-peer transport: a p2p stack (any-sync, iroh, libp2p) vs WebRTC over our own relay | **WebRTC data channels, signalled by the relay we already run, with that same relay as the fallback path** (`collab/src/webrtc.ts`, `native/swift/Sources/NbeSync/P2PTransport.swift`) | Added 2026-08-08 from `docs/research/p2p-any-sync.md`. any-sync — the most complete implementation of this shape in production — contains **no WebRTC**: yamux over TCP, QUIC with libp2p-TLS, WebTransport, and no NAT traversal anywhere in the transport. Its peer-to-peer is mDNS on the LAN plus direct dial; off the LAN it goes through an always-on sync node, and a deployment is four node types with MongoDB, Redis and S3. Reachability and availability force that on anyone, us included. And "fully p2p over WebRTC" is not a thing: signalling is a server, STUN is a server, TURN is a *relay* carrying every byte for the 8–20% of connections that never go direct. So the honest version is a ladder, and the saving is not the server but **what the server carries**: the relay negotiates and then sees nothing. It doubles as TURN, which is one service instead of two, and it is the transport that already existed rather than a degraded mode. **The trap:** a peer that cannot speak WebRTC never announces itself, so meshing peers counting greetings would silently orphan `nbe serve` — the relay therefore reports room membership, the one fact only it knows. **Verified by** `e2e/p2p.spec.ts` (two browsers, sockets closed mid-test), `packages/cli/test/p2p.test.ts` (real libdatachannel, relay killed mid-test) and `native/swift`'s `P2PTests` |

## 12. Open questions (tracked, not yet designed)

From the adversarial completeness review — each needs a design pass before its
phase begins:

1. **Storage runtime/platform.** *Resolved 2026-08-07 for two runtimes.* The
   browser writes pages to IndexedDB (`@nbe/workspace/idb`); a machine writes
   one JSON per page with atomic temp+rename (`@nbe/cli`), so a crash leaves
   the old page or the new one and never a truncated one. External edits are
   picked up by polling content hashes, not `fs.watch`, whose behaviour differs
   per platform and per editor. Concurrent writers are
   excluded by a lock file (exclusive create, pid plus heartbeat); a stale lock
   is reclaimed only when the process is gone *and* the heartbeat stopped, so a
   crash cannot lock a workspace forever and a recycled pid cannot be mistaken
   for an abandoned one. **Still open:** a desktop shell.
2. **Binary asset pipeline.** *Resolved 2026-08-07 for the browser runtime.*
   Blobs live in a content-addressed store and the document holds an opaque
   `asset:<hash>` ref, so dedup is free and the model never carries bytes.
   Collection is **mark-and-sweep, never reference counting** — counts drift
   under undo, multiple tabs and crashes, and a wrong count deletes an image
   someone still has on screen. `referencedAssets` in `@nbe/workspace` is the
   mark and looks at prop *values* rather than a list of props allowed to hold
   one, so a block type added later needs no change and cannot be forgotten.
   The sweep runs **once at load**, which is the safety argument rather than an
   implementation detail: an undone deletion restores its blocks, so a blob is
   only garbage while nothing can bring a reference back, and the undo history
   lives in memory and dies with the page. **Still open:** a second tab does
   have a history, so sweeping can strand its undo — the answer is single-writer
   election, which belongs with phase 4b's real storage. Blobs sit in an
   `assets/` folder beside the Markdown, and a page refers to one by a path
   relative to its own depth, so a vault stays self-contained wherever it is
   moved; the import restores the opaque ref.
3. **The simple table block.** *Resolved 2026-08-06 and shipped.* Cells are
   ordinary blocks (`table` / `table_row` / `table_cell`), so no new op types
   were needed — a column insert is a transaction of per-row `insert_block`,
   and undo is free. `normalizeTables` holds two invariants: every row has
   exactly `columnCount` cells, and a table with no rows or columns dissolves.
   One CSS grid on the table with `display: contents` rows keeps column widths
   in a single template. Tab/Shift+Tab walk cells (Tab past the last one
   appends a row); Enter moves down instead of splitting. Round-trips as a GFM
   pipe table; `<table>` and aligned TSV paste build a real table.
   **Still open:** cell-range selection as a third selection kind, column
   resize handles, and cell merging — none block the block itself.
4. **Unicode correctness.** *Resolved 2026-08-07.* Offsets stay UTF-16 code
   units — that is what the DOM speaks, and §2.2 is unchanged — but every edit
   that *moves* or *bounds* one now works in perceived characters
   (`core/src/grapheme.ts`, over `Intl.Segmenter`, which implements UAX #29 so
   nobody maintains that table by hand; engines without it fall back to the old
   surrogate-pair behaviour rather than breaking). Backspace and Delete step one
   cluster, so a family emoji leaves in one press instead of coming apart into
   its people; `marksAt` reads the preceding *character*, so typing after an
   emoji keeps its formatting; and `resolveTextRange` snaps a range **outward**
   onto cluster boundaries, so a range that landed mid-character — from a
   paste, a restored caret bookmark, or a browser-reported selection — grows to
   cover the whole character rather than splitting it. Outward and never
   inward, because growing keeps every character the user meant while shrinking
   would silently drop one. **Not addressed:** bidi caret movement, which the
   browser owns inside a leaf (§5.1), and normalisation between NFC and NFD,
   which is a storage-policy question rather than an editing one.

5. **Markdown parser/serializer engineering.** *Resolved by shipping, recorded
   2026-08-08.* **Custom**, in `@nbe/markdown`, and the reason is the same one
   as D2: remark and markdown-it both produce their own AST, so adopting either
   means maintaining a translation to our blocks *and* inheriting their idea of
   what a document is. The parser is line-based — a line is a block, which is
   how Notion's own paste behaves — and the serializer is deterministic.
   Diff-stability is the **idempotence** property under test in D7, not equality
   with the source. ID-preserving re-import works through frontmatter and is
   verified end to end (`e2e/vault.spec.ts`). The remaining known cost, stated
   rather than discovered: our parser is not CommonMark, and a construct it does
   not know becomes a paragraph rather than an error.
6. **Editor test automation.** *Largely resolved 2026-08-08; what is left needs
   devices.* The answer to "Playwright/CDP limits" turned out to be: CDP does
   more than expected and covers less than needed, and knowing which is which is
   most of the value.
   - **Composition** is drivable — `Input.imeSetComposition` runs Chromium's
     genuine pipeline, and AppKit's `NSTextInputClient` is callable directly in
     the Swift suite. Both found real bugs (`e2e/ime.spec.ts`,
     `BlockTextViewTests`).
   - **Clipboard and drag** are covered, and the two tests that cannot exist
     outside Chromium say so explicitly rather than failing red — a red build on
     a known gap teaches people to ignore red builds.
   - **The matrix is real now**: Chromium, WebKit (Safari's engine, therefore
     iOS's), a `singleHostTopology` variant, and touch at iPhone and Pixel
     viewports — four browser projects, all gating. WebKit found a data-loss bug
     in its first run.
   - **Still needs hardware**, and nothing simulates it: a particular IME's
     behaviour, the software keyboard, and non-US layouts with dead keys. The
     keyboard's *effect* is simulated (`packages/dom/test/viewport.test.ts`);
     its input stack is not.
7. **Touch/mobile interaction design.** *Largely resolved 2026-08-07; the
   device half remains.* The first measurement was not about gestures: at 390px
   the editor was **not on screen at all**, because the demo's three fixed
   columns pushed it out of the window — so the panels are drawers below 900px
   and the editor is the application. Then dragging a block did nothing, no
   indicator and no move, because nothing set `touch-action`: the browser
   claimed the sequence for scrolling and cancelled the pointer. The gesture
   router now captures the pointer and the chrome that starts a drag declares
   `touch-action: none`. Tap targets grow to 44px under `(pointer: coarse)` via
   a pseudo-element, so the layout does not change on a desktop that happens to
   have a touchscreen. `attachViewportGuard` keeps the caret above a virtual
   keyboard using `visualViewport` — `window.innerHeight` cannot see it, since
   the keyboard does not resize the layout viewport — and it moves only when
   the caret is actually hidden, so it does not fight pinch-zoom. **Still
   open:** long-press to grab a block without going through the gutter, and
   everything only a real device shows — iOS Safari's selection handles over a
   painted cross-block highlight (see question 9), and Android's own
   text-selection chrome. Emulation gets the events right and the engine wrong.

8. **Database evaluation engine.** *Resolved 2026-08-07 — and most of it was
   already there.* The formula language (parser, evaluator, functions,
   dependency extraction) and the evaluation of relations and rollups live in
   `core/src/{formula,db}.ts`; `computeRow` resolves computed columns *before*
   filters, sorts and grouping run, so a formula or a rollup can be filtered
   and sorted on like any other column, and a formula that references another
   formula is ordered by dependency with a cycle returning null rather than
   hanging. What was actually missing was the reading half: a CSV parser that
   knew only the comma, and that split lines before looking at quotes. A
   spreadsheet on a French, German or Spanish system writes **semicolons**,
   because those locales use the comma as a decimal separator — such a file
   imported as one silent column. And a quoted field may contain a newline,
   which Notion writes, so any multi-line cell shifted every column after it.
   `workspace/src/csv.ts` scans characters instead of lines, guesses the
   delimiter by *consistency* rather than frequency, and handles BOM and CRLF.
   **Not built, deliberately:** incremental recompute. `evaluateView`
   recalculates the whole collection per render, which is milliseconds at the
   size a person's database reaches; the fix when it stops being so is to cache
   per row against a dependency set, not to make the computation partial.

9. **Whether the accessibility gap forces single-host** (opened 2026-08-07 by
   D3's falsification, narrowed the same day). The default is settled:
   **per-block ships**, because the reason to abandon it — no cross-block
   selection — was paid off by painting the model's range instead, and because
   switching was measured to be not free (under `singleHostTopology` the whole
   e2e suite runs but markdown autoformat stops firing: the input path is
   written against per-block).

   What remains open is the one cost painting cannot cover: a `Highlight` is
   not a `Selection`, so a screen reader does not announce it and find-on-page
   does not extend it. Under `singleHostTopology` both work natively, at the
   price of a permanently editable container the browser restructures — the
   decade of reconciler workarounds D2 exists to avoid, which Gutenberg tried
   in July 2026 and reverted in August. Notion, for reference, uses a
   permanently editable page root.

   Deciding needs the screen-reader half of the matrix in `docs/TESTING.md`,
   run against both topologies. Both remain implemented and interchangeable
   (`topology.ts`) and the selection suites run against both, so this stays a
   measurement rather than a rewrite.
