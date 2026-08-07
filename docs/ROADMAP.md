# Roadmap

> **Status (2026-08-06).** Phase 0 folded into Phase 1 (the per-block
> contenteditable hypothesis D1 was implemented directly; the A/B spike is
> superseded by the working editor — revisit only if IME/screen-reader testing
> falsifies it). **Phase 1 is functionally complete**: core + dom + markdown
> packages, the six-pattern UX (slash menu, hover +/handle with block menu,
> block-selection key contract, drop guides with drag & drop columns,
> autoformat, caret-only placeholders), three-format clipboard,
> callout/image/page-link blocks, multi-page demo with L0 persistence
> (localStorage), aria-live announcements and single-tab-stop focus.
> **Residuals pass (2026-08-06, post-phase-1):** goal-X arrows ✓,
> MutationObserver extension defense ✓ (foreign text merges into the model,
> foreign markup reverted), paste fixture corpus ✓ (14 fixtures: GDocs, Word,
> Excel, VS Code, web), forward-merge on Delete ✓ (void blocks get selected),
> image asset pipeline ✓ (opaque `asset:<sha256>` refs + host store/resolve
> hooks; demo uses IndexedDB; GC at phase 4), rubber-band selection ✓, UI
> primitives layer ✓ (position/menu/tooltip/hover/drag, D8 in-house DnD).
> **Shipped since:** simple table (2026-08-06, AQ#3 resolved) minus cell-range
> selection, column resize and cell merging; Word mso-list paragraphs now parse
> as real list items (nesting still flattened, recorded in the fixtures).
> **Still open:** real-device IME/screen-reader matrix — protocol written in
> `docs/TESTING.md`, needs hardware (AQ#6); native-feel cross-block text
> selection (block-escalation shipped per D3).
>
> **Phase 3 slice 1 (2026-08-06) — databases, started BEFORE Phase 2 by
> decision.** Shipped: the four record kinds (database view block in the core
> schema; CollectionSchema + ViewConfig as host records; rows as pages with
> `props.{collectionId,properties}`), pure filter+sort engine in core
> (`db.ts`, 7 property types, type-aware compare, missing-last, 10 tests),
> interactive table view in dom (`database.ts` on the ui primitives: per-type
> cell editors with native date input, select/multi-select option menus with
> creation, property add/rename/retype/delete, one-filter/one-sort UI,
> row open/delete), `DatabaseHost` contract, demo host over the localStorage
> workspace (rows hidden from the sidebar, save flushed on pagehide).
> **Phase 3 remaining after slice 1:** board/list/gallery layouts,
> multi-filter/multi-sort UI (engine already supports lists), groups, formula
> language (AQ#8), relations/rollups, view virtualization, the L2 derived
> index, markdown/CSV projection of collections — all shipped by 2026-08-06
> except L2, which is deferred and is per-runtime rather than one decision
> (see Phase 3 below).

> **Theming (2026-08-06).** Every colour in the stylesheet now resolves from
> the token block: six base channels (`--nbe-ink`, `--nbe-ink-warm`,
> `--nbe-accent-rgb`, `--nbe-danger-rgb`, `--nbe-shadow-rgb`, `--nbe-surface`)
> plus the named block palette. Dark mode remaps those and nothing else — not
> one rule is duplicated. It follows the OS preference by default; a host with
> its own theme switch sets `data-nbe-theme="dark"` or `"light"` on the editor
> or on `<html>`, which is what reaches the menus and tooltips portaled out to
> the document body. The editor also paints its own page background now, so a
> dark theme cannot end up as white text on the host's white page.

> **Plugin architecture pulled forward (2026-08-07).** Adding one block type
> today touches **14 files across 4 packages**, and there are 18 closed
> dispatches on `block.type` in the source. The declarative half of the
> extension point is right and per-instance (`BlockSpec`, `Schema`); the
> behavioural half — render, keys, menu actions, paste, and both projections —
> never travels with the spec. That makes the "single extension point" of §4
> open in principle and closed in practice, and it is now the binding
> constraint on everything the roadmap calls ecosystem. Phase 4 would add a
> *fourth* projection (the vault), far cheaper to add to a contribution API
> than to a fifth closed switch. Research: `docs/research/plugin-architecture.md`.
> Plan: `docs/design/plugin-refactor-plan.md`. Target shape, Tiptap-style —
> activation is an import plus an array entry, and not importing a block keeps
> it out of the bundle.

> **Interaction core rebuilt (2026-08-07).** The cornerstone — text selection,
> caret, keyboard, rubber band, block reordering, overlay dismissal — was six
> systems negotiating by accident. Measured: five unarbitrated pointer
> listeners on one surface, three wall-clock coordination windows (500/300/400
> ms), eight Escape handlers with no precedence, the per-block
> `contenteditable` decision hardcoded into `leafOf()`, and zero tests.
> Rebuilt on three primitives — an overlay stack, an `EditableTopology`, and a
> gesture router — leaving 1 listener, 0 timing windows, 0 unordered Escape
> handlers, 2 selectable topologies and 51 tests. **D1's unspiked alternative
> is now a config change**: `singleHostTopology` ships beside the per-block
> one and the same selection suite runs against both, so the A/B the roadmap
> wanted is finally cheap. Design and measurements:
> `docs/design/interaction-core.md`.

> **Presentation site (2026-08-07).** Astro, in `site/`. Chosen over TanStack
> Start because it renders React, Vue and Svelte islands natively on one page,
> which is what documenting three framework bindings actually requires — the
> alternative turns two of the three integrations into screenshots.

Phases are sequential gates, not a calendar. Each phase ends with something
usable; nothing in a later phase is allowed to require rewriting an earlier
one — that's what the "cheap now, priceless later" invariants below are for.

## Invariants bought in v0 that pay off in v5

The whole point of the research phase. These cost almost nothing today and are
decade-scale retrofits later (Notion paid for each one):

- Stable client-generated UUIDv7 block IDs, never semantic, never reused
- Every mutation = serializable invertible op through one reducer
- No persisted integer offsets or DOM positions, anywhere
- `parentId` inverse pointer maintained alongside `children` arrays
- Move as intent (parent + after-sibling ID), never delete+reinsert
- Soft-delete tombstones
- `schemaVersion` on every document; additive-only evolution; unknown
  types/props round-trip untouched
- Columns and nesting in the core schema (BlockNote/Editor.js prove they
  cannot be retrofitted)
- Marks carry declared expansion semantics (Peritext), dormant until CRDTs
- Selection model is cross-block capable even while the UI isn't

---

## Phase 0 — Spikes (de-risk before building)

The one genuinely open architecture fork gets settled by prototype, not
debate.

**Spike A — editable surface (the big one).** Two throwaway prototypes of a
3-block page: (1) per-block `plaintext-only` leaves, (2) single editable root
with minimal reconciler. Test matrix: Android Chrome + GBoard (mid-word
backspace, autocorrect), CJK IME composition, VoiceOver + NVDA reading and
navigating, cross-block selection behavior, Grammarly installed.
**Exit criterion:** D1 confirmed or reversed with written evidence.

**Spike B — markdown round-trip.** One gnarly fixture page (columns, toggles,
callout, code, mentions, a fake database) → L1 projection → hand-edit in
Obsidian → re-import → L0 diff. **Exit criterion:** loss boundary documented;
`^id` preservation works; parser stack chosen (open question #5).

**Spike C — InlineEditor kernel.** The dual input path (beforeinput +
MutationObserver + composition freeze) as a standalone module with its IME
test matrix runnable locally. This module's API is the most important
interface in the project.

Also in phase 0: monorepo bootstrap (pnpm workspaces, tsdown ESM-only, Vitest,
publint), `core` package skeleton with the op reducer + history and **headless
op-layer tests** — the editor logic gets tested without a browser from day one.

## Phase 1 — L'éditeur parfait (v1, the reason this project exists)

Packages: `core`, `dom`, `examples/vanilla`. Zero framework code.

**Model & pipeline:** the full §2–§4 architecture — block store, 7 ops,
transactions, inverse-op history with coalescing, schema registry with
versioned migrations, per-block validation at apply.

**Block set:** paragraph, headings 1–3, bulleted/numbered list, to-do, toggle,
quote, callout, code (with language), divider, image, columnList/column,
page, link-to-page. (Simple table is deliberately post-v1 — open question #3.)

**The six-pattern Notion UX core, at high fidelity — this is the quality bar,
not a feature list:**
1. Slash menu with real-time filtering + aliases
2. Hover-only + button and drag handle with the block menu (Turn into, Color,
   Duplicate, Delete, Copy link to block, Move to)
3. Esc/Enter block-selection ↔ text modes with the full key contract
4. Blue drop guides, horizontal and vertical (columns by drag only)
5. Full markdown autoformat table (`# `, `- `, `[] `, `> `, ` ``` `, `---`)
6. Caret-only placeholder ("Type / for commands")

Plus: non-destructive Turn Into everywhere, per-block stable URLs/anchors,
subtle hover/toggle transitions (150–200 ms, the Notion feel — polish is in
scope for v1, it's the product).

**Interactions:** clipboard three-format copy + full paste pipeline + fixture
corpus; pointer-based drag with multi-block preview and column drops;
Enter/Backspace command chains per block type; goal-X arrow navigation.

**Accessibility:** Navigation/Edit modes, single tab stop, drag parity via
handle menu, live regions, NVDA+VoiceOver smoke tests in CI checklist.

**Persistence:** L0 JSON save/load (single page, then multi-page workspace +
wikilink mentions + derived backlink index). Local-first single-writer
discipline. L1/L2 wait.

**Explicit non-goals for v1:** frameworks bindings, databases, collab,
mobile-touch design, virtualization, table block, plugin distribution story.

## Phase 2 — SDK & bindings (TanStack-shaped) — **done 2026-08-06**

Shipped: `@nbe/static-renderer` (JSON → HTML, no editor instance, no DOM
globals, list-run grouping, asset/page resolvers, 11 tests); `@nbe/react`
(`useEditor` + `<BlockEditor>`, StrictMode-safe single mount verified),
`@nbe/vue` (composable + component), `@nbe/svelte` (`use:blockEditor` action —
plain TS, no compiler in the SDK); `examples/react|vue|svelte` each building
in CI with a live static-render pane; packaging invariants enforced by
`test/packaging.test.ts` (core has zero deps and no DOM globals, projection
packages never import dom, bindings are exactly core+dom+framework peer,
every package ESM-only and side-effect free).
Deferred deliberately (ARCHITECTURE §9 "add when they hurt"): Changesets,
size-limit budgets, sherif/knip, Nx, docs site — none of them hurt yet at
7 packages with no publish.

### Original scope

- `react`, `vue`, `svelte` mounts — thin by CI-asserted dependency contract;
  custom-block portal bridge; controller-store chrome wrapped per framework
- Block author API hardened: `blocks-*` split (schema entry vs /dom renderer),
  end-to-end type inference from the registered schema
- `static-renderer` (JSON → HTML/Markdown, no editor instance, SSR-safe)
- `examples/react|vue|svelte` as CI-checked workspace packages
- Docs site from in-repo markdown; publish pipeline (Changesets, size-limit
  budgets, sherif/knip)

> **Publish tooling deferred, 2026-08-06.** Deliberately not started, because
> every piece of it needs a decision that has not been made. The packages
> currently export `src/*.ts` directly, which works for bundler consumers and
> is why the examples run, but it ships TypeScript to consumers and type-checks
> our sources against *their* tsconfig. A real release needs, in order:
>
> 1. **A build** (tsdown, per §9's ESM-only intent) — nothing downstream is
>    meaningful without it. Size budgets in particular measure build output, so
>    adding them first would measure nothing.
> 2. **A licence.** None is chosen and no LICENSE file exists; the manifests
>    deliberately carry no `license` field rather than an invented one.
> 3. **A repository URL.** There is no git remote yet, so `repository` is
>    likewise absent rather than guessed.
> 4. **Changesets** for versioning and changelogs across the seven packages —
>    useful from the first release, pure ceremony before it.
>
> The layering invariants that *do* matter today are already CI-enforced in
> `test/packaging.test.ts`; what is missing is release machinery, not
> architecture.

## Phase 3 — Databases — **done 2026-08-06** (except the L2 index)

Delivered in four slices after Phase 2:
1. **Foundation** — the four record kinds (`database` view block in the core
   schema; `CollectionSchema` + `ViewConfig` as host records; rows as ordinary
   pages carrying `props.{collectionId,properties}`), the pure filter/sort
   engine, the interactive table view, the `DatabaseHost` contract.
2. **Views** — table / board / list / gallery layouts (the gallery infers its
   cover from a url property that points at an image, so no file property type
   is needed yet), grouping (declared options become
   board columns, no-value group last, multi-select rows fan out), cards
   draggable between board columns (the drop writes the group property),
   multi-filter and multi-sort panels, property visibility.
3. **Scale** — views render progressively: 50 rows at first paint, the next
   page appended by an IntersectionObserver sentinel, and the rendered depth
   remembered per view so a re-render (any cell edit replaces the whole block)
   does not throw the reader back to the top.
4. **Computation (AQ#8)** — a total pure formula language (tokenizer, Pratt
   parser, evaluator; no clock, no randomness, never throws), relations,
   rollups (count/sum/average/min/max/show) across collections, all resolved
   before filtering/sorting/grouping so views work on derived values.
   Plus the L1 projection: RFC-4180 CSV export/import (materialized computed
   columns are marked and never re-imported as data), one readable `.md` per
   row with YAML frontmatter, and an Obsidian-Bases-shaped `.base` view file.

**Deliberately deferred: the L2 index — and it is not one decision but two.**
Corrected 2026-08-07: SQLite belongs to a *backend* runtime (server, desktop,
CLI) where the workspace is real files on a real filesystem. In the browser,
L2 is IndexedDB or OPFS — shipping SQLite/WASM to the browser would mean a
WASM binary and a single-writer worker to rebuild a cache the platform already
knows how to store, and the cache holds nothing unique by design. Because L2
holds zero unique information, the two can differ per runtime without the
document layer noticing. Nothing shipped in Phase 3 blocks either.

### Original scope

- The four record kinds (view block / view / schema / rows-as-pages) wired
  into the editor
- Table view first: filters, sorts, groups; board/list/gallery after
- Property types: text, number, select, multi-select, date, checkbox, url,
  relation; formula language design (open question #8) before rollups
- Views virtualize internally (the one sanctioned virtualization) — shipped as
  progressive rendering rather than true windowing: the first 50 rows paint and
  an IntersectionObserver sentinel appends the next page as it scrolls into
  view, with the rendered depth kept across re-renders so editing a cell far
  down a view does not snap back to the top. Native scrolling, find-in-page and
  text selection keep working, which absolute-positioned windowing gives up;
  revisit only if a real collection makes memory the binding constraint.
- L2 lands here, per runtime: IndexedDB/OPFS in the browser, SQLite (FTS5
  search, backlinks, materialized views) on a backend — derived, rebuildable,
  single writer

## Phase 4 — Storage & interop (file-over-app, fully honored)

- Full L1 vault projection: Obsidian-flavored markdown per page, one .md per
  database row + `.base` view files + rows.csv
- Watcher-based external-edit import (Obsidian/vim round-trip), atomic writes,
  crash safety (open question #1)
- Binary asset pipeline (open question #2)
- Notion importers: ZIP export and Enhanced Markdown
- The acceptance test becomes CI: delete the app, read the files

## Phase 5 — Collaboration, native, ecosystem (the long game)

- **CRDT:** Loro is the presumptive choice (MovableTree, Peritext-grade text,
  Rust core shared with Swift bindings) behind the same store interface the
  plain-JSON implementation satisfies — audit, then adopt when this phase
  starts, not before
- **Sync:** opaque update blobs over pluggable transports (Automerge-Repo
  pattern); default ~100-line self-hostable websocket relay; iroh for p2p
  native later; presence on a separate ephemeral channel; ACL outside the CRDT
- **Native Swift editor:** same JSON schema + registry, per-block TextKit 2
  views, SwiftUI chrome, loro-swift when collab lands (Craft proves the
  category)
- **Obsidian:** decide plugin vs standalone app once L1 vaults are stable —
  an L1 workspace already *is* an Obsidian vault, which keeps both doors open
- Mobile/touch interaction design (open question #7)

---

## Research follow-ups

Before the phase that needs them (owner: whoever starts the phase):

| Topic | Blocks | Ref |
|---|---|---|
| Storage runtime (browser FS/OPFS vs Tauri vs CLI) | Phase 1 persistence | AQ#1 |
| Markdown parser stack + diff-stable serialization | Spike B | AQ#5 |
| IME/clipboard/drag simulation in CI | Phase 0–1 | AQ#6 |
| Unicode grapheme handling at boundaries | Phase 1 | AQ#4 |
| Asset pipeline | Phase 4 | AQ#2 |
| Table block design | ~~post-v1~~ shipped 2026-08-06 | AQ#3 |
| Touch interaction design | Phase 5 | AQ#7 |
| Formula/eval engine | Phase 3 | AQ#8 |

(AQ# = open questions in ARCHITECTURE.md §12.)
