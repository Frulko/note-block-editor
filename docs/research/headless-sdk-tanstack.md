# TanStack Philosophy Applied to an Editor SDK — Headless Core, Thin Adapters, Monorepo

Research date: 2026-08-06. All repo facts below were read directly from the current `main` branches of TanStack/table, TanStack/query, TanStack/store, ueberdosis/tiptap and TypeCellOS/BlockNote via the GitHub API, plus official docs and the TanStack Table v9 engineering blogs.

## TL;DR

- TanStack's model is **core-plus-adapter**: ~95% of code lives in a framework-free TS core (`@tanstack/table-core`, `@tanstack/query-core`), and per-framework packages are thin bridges whose *entire dependency list* is the core plus (optionally) a reactivity adapter — `@tanstack/react-query`'s only dependency is `query-core`; `@tanstack/react-table`'s are `table-core` + `@tanstack/react-store`.
- Table v9 (2026) is the state of the art: core state is a graph of **TanStack Store atoms** (alien-signals architecture), and the core depends on reactivity only through a tiny injected contract (`TableReactivityBindings`: `createWritableAtom`, `createReadonlyAtom`, `batch`, `schedule`, `untrack`). Signal frameworks (Solid/Vue/Svelte/Angular) plug their native primitives straight in; React bridges via `useSyncExternalStoreWithSelector`.
- The v8→v9 rewrite exists because **React assumptions had leaked into the "framework-agnostic" core**; it took 4 years to unwind. That is the single most important lesson for us.
- Monorepo stack actually in use today: **pnpm workspaces + Nx (affected/cache) + Changesets + tsdown/tsup builds + publint --strict + attw --pack + sherif + knip + size-limit + Vitest + Playwright**, with `examples/<framework>/*` as workspace packages and docs as in-repo Markdown consumed by tanstack.com. TipTap uses pnpm + Turborepo + Changesets; BlockNote uses Vite Plus + tsgo.
- Table v9 shipped **ESM-only** with `tsdown`; Query still ships dual ESM/CJS with `tsup` and pays for it with attw/publint machinery and a TS 5.4→6.0 type-check matrix. New library in 2026 → ESM-only.
- TipTap's core is genuinely framework-free (v3 even added framework-agnostic JSX for `renderHTML` and a static renderer), but the extension layer leaks: `extension-drag-handle-react`, `-vue-2`, `-vue-3` are per-framework forks of one feature — the smell to avoid.
- BlockNote validates our exact ambition (Notion-style, `@tanstack/store` inside core, TipTap/ProseMirror underneath) but is **React-only in practice**: all toolbars/menus/slash-menu UI live in `@blocknote/react`, the docs explicitly say vanilla use is "not recommended", core ships CSS and `emoji-mart`, and multi-column is a separate GPL/commercial `xl-` package.
- For an editor, the headless boundary sits differently than for a table: the **vanilla-TS DOM view is itself shared infrastructure** (the ProseMirror precedent — every React/Vue binding wraps `prosemirror-view`, nobody reimplements contenteditable per framework). Framework adapters do only: mount/lifecycle, reactive state projection, and rendering custom block components into DOM-owned slots (portals).
- Proposed graph: `@x/core` (schema+state+commands, dep: `@tanstack/store` only) ← `@x/dom` (the one true view) ← `@x/react`/`@x/vue`/`@x/svelte` (thin mounts); `@x/markdown`/`@x/sqlite` depend on **core only, never dom** — that's what keeps Swift/CLI/server ports possible.

---

## Findings

### 1. The TanStack architecture model (2026)

#### 1.1 Headless means logic-only, and the core is almost everything

TanStack Table "does not render any DOM elements, markup, or styles"; it manages state and logic (sorting, filtering, grouping, selection, pagination) and exposes an API the consumer wires to their own UI. Roughly 95% of the source is vanilla, framework-agnostic TypeScript in `@tanstack/table-core`; adapters exist for React, Preact, Vue, Solid, Svelte, Angular, Lit, Alpine, Ember and Octane ([TanStack Table Overview](https://tanstack.com/table/latest/docs/overview), [Announcing TanStack Table V9](https://tanstack.com/blog/announcing-tanstack-table-v9)).

Verified dependency lists (the sharpest measure of "thin"):

| Package | Runtime dependencies | Peer deps |
|---|---|---|
| `@tanstack/table-core` 9.0.0 | `@tanstack/store` ^0.11 — nothing else | — |
| `@tanstack/react-table` 9.0.0 | `@tanstack/table-core`, `@tanstack/react-store` | `react >=18` |
| `@tanstack/query-core` 5.101.x | **none** | — |
| `@tanstack/react-query` | `@tanstack/query-core` — nothing else | react |
| `@tanstack/svelte-query` | `@tanstack/query-core` — nothing else | svelte |

The svelte-table adapter is ~16 small files (runes-based `.svelte.ts` modules, a `FlexRender.svelte`, context keys, a `createTableHook`); react-table is ~12 files (`useTable`, `Subscribe`, `FlexRender`, contexts, a legacy shim). Adapters are measured in hundreds of lines, not thousands ([TanStack/table repo](https://github.com/TanStack/table)).

#### 1.2 What an adapter actually does

Each adapter provides exactly three things ([Announcing TanStack Table V9](https://tanstack.com/blog/announcing-tanstack-table-v9)):

1. **An idiomatic entry point** — `useTable()` hook (React), composable with ref unwrapping (Vue), rune-based `$derived` projections (Svelte 5), `signal()`/`computed()` (Angular), direct atom participation (Solid). All built on the shared `constructTable` from core.
2. **A reactivity binding** — connecting core state atoms to the framework's change-tracking (see 1.3).
3. **A rendering escape hatch** — `flexRender` / `FlexRender`, the tiny helper that takes "component-or-string-or-function" column definitions from the framework-neutral core and renders them with the framework's own renderer. This is the *only* place "rendering" touches the adapter; notably v9 moved a neutral `flex-render` entry into `table-core` itself as a subpath export.

#### 1.3 Reactivity: TanStack Store atoms + an injected bindings contract

This is the crown jewel of v9's design and directly reusable for us ([Inside TanStack Table V9 Reactivity](https://tanstack.com/blog/tanstack-table-v9-reactivity)):

- **The v8 problem:** the core kept a stable instance synced via `setOptions()`/`setState()`. Frameworks couldn't see which state a method like `table.getRowModel()` read, so any change invalidated everything — selecting one row re-rendered the whole table. The proxy-wrapping workaround created O(rows × cells × methods) reactive wrappers, hid dependencies, and was invisible to React Compiler.
- **The v9 solution:** each feature-state slice (pagination, row selection, column sizing, filters…) is its own reactive **atom**; `table.store` derives the aggregate for compatibility. Reads like `table.atoms.rowSelection.get()` and `table.options.enableRowSelection` participate in a dependency graph, so a checkbox depends only on `rowSelection`, not the whole table. User options (`data`, `columns`, callbacks) are also in the graph via `table.optionsStore`.
- **The decoupling trick:** the core doesn't hardcode `@tanstack/store`. It defines a contract:

```ts
interface TableReactivityBindings {
  createWritableAtom: <T>(value: T) => Atom<T>
  createReadonlyAtom: <T>(fn: () => T) => ReadonlyAtom<T>
  batch: (fn: () => void) => void
  schedule: (fn: () => void) => void
  untrack: <T>(fn: () => T) => T
}
```

  Signal-native frameworks supply their own primitives (`createSignal`/`createComputed` in Solid); store-backed frameworks (React, Preact, Alpine) use `@tanstack/store` atoms + `useSyncExternalStoreWithSelector`. The default bindings ship as a `table-core` subpath: `@tanstack/table-core/store-reactivity-bindings`.
- `@tanstack/store` itself (v0.11.x, "alien-signals architecture") is a small framework-agnostic signals implementation — `createStore`, derived stores, `batch`, subscriptions — with adapter packages for react/preact/vue/solid/svelte/angular/lit/octane ([TanStack Store](https://github.com/tanstack/store), [Store quick start](https://tanstack.com/store/latest/docs/quick-start)).
- Payoff numbers: up to 86% less retained heap (shared prototypes for row/column/cell APIs), 79% faster core row processing, granular updates compatible with React Compiler ([Announcing V9](https://tanstack.com/blog/announcing-tanstack-table-v9)).

Query, by contrast, predates Store and rolls its own observer pattern (`QueryObserver` + listener sets) in a zero-dependency core; adapters subscribe via `useSyncExternalStore` (React) or framework equivalents. Both models prove the same point: **core owns state + notification; the adapter only translates notification into the framework's render scheduling.**

#### 1.4 How types flow

- Core is TypeScript-first; adapters re-export core types and add only entry-point signatures. Generics flow from the instance creation call (`useTable<TData>`…) through everything.
- Table v9 replaced **global declaration merging** (v8's `declare module` for column meta) with **per-table metadata typing** carried in generics, and made the feature system type-gated: "Feature APIs only exist when available" — a table constructed with only `rowPaginationFeature` neither ships nor *types* sorting APIs ([Announcing V9](https://tanstack.com/blog/announcing-tanstack-table-v9)). TipTap still uses global module augmentation for its `Commands` interface — it works but makes commands globally visible even when the extension isn't loaded.
- Query maintains a **TypeScript version compatibility matrix in CI**: `query-core` runs `tsc` against typescript 5.4, 5.5, 5.6 … 6.0 via npm aliases (`"typescript54": "npm:typescript@5.4"`) — verified in `packages/query-core/package.json` ([TanStack/query](https://github.com/TanStack/query)).
- Query uses a custom exports condition (`"@tanstack/custom-condition": "./src/index.ts"`) so workspace-internal consumers resolve to raw sources during dev (no build step in the inner loop), while the published exports resolve to `build/modern`.

### 2. Monorepo mechanics: what the repos actually use (verified August 2026)

#### 2.1 TanStack Table (the newest, post-v9 setup)

From the live `package.json`, `nx.json`, `pnpm-workspace.yaml`:

- **pnpm 11 workspaces** (`packages/*` + `examples/**/*`), with `overrides: workspace:*` for every own package so examples always use local sources. Supply-chain hardening is notable and new: `minimumReleaseAge: 1440` (packages must be 24h old before install), `trustPolicy: 'no-downgrade'`, `blockExoticSubdeps: true`, an explicit `allowBuilds` allowlist for postinstall scripts.
- **Nx 22** for orchestration: `nx affected --targets=build,test:lib,test:types,...` in CI, `nx run-many` locally, remote cache via Nx Cloud, `dependsOn: ["^build"]` so a package builds after its workspace deps, `nx watch --all` for dev. Nx is used purely as a task graph over `package.json` scripts (`useInferencePlugins: false`) — no Nx plugins, no generated project.json ceremony.
- **Builds: `tsdown`** (the Rolldown-based successor of tsup), one `tsdown.config.ts` per package. Output is **ESM-only**: `"type": "module"`, exports map values are plain strings (`".": "./dist/index.js"`), no `require` condition at all, `sideEffects: false`, `files: ["dist"]`. TypeScript 6.0.3.
- **Package QA belt** (each package's scripts): `test:build` = `publint --strict` (packaging correctness — [publint](https://publint.dev)); repo-level `test:sherif` = [sherif](https://github.com/QuiiBz/sherif) (monorepo lint: no version drift between packages); `test:knip` = [knip](https://knip.dev) (unused files/deps/exports); `size-limit` with a hard **25 KB budget on `table-core`** enforced on every build; Vitest 4 for unit, Playwright for e2e, `tsc` for `test:types`.
- **Changesets** for versioning/publishing (`changeset version` + `changeset publish`, `@changesets/changelog-github`).
- **Subpath exports as architecture**: `table-core` exports `./reactivity`, `./store-reactivity-bindings`, `./flex-render`, `./static-functions`, `./experimental-worker-plugin` (row processing in a Web Worker) — optional capabilities are separate entries, not options objects.
- **Examples** = 11 framework folders (`examples/react`, `vue`, `svelte`, `solid`, `angular`, `lit`, `alpine`, `ember`, `octane`, `preact`, **`vanilla`**) that are real workspace packages, excluded from publish, included in `nx affected` CI. The existence of `examples/vanilla` is itself a design assertion: the core must be usable with no framework.
- **Docs in-repo**: `docs/` holds Markdown (`overview.md`, `guide/`, `framework/<name>/`, `reference/` generated with `@tanstack/typedoc-config`) plus a `config.json` manifest; tanstack.com renders it from the repo. `README.md` is copied into every package before publish.
- **New in 2026 — agent skills**: packages ship a `skills/` folder ("tanstack-intent" keyword, `@tanstack/intent` validation, `test:skill-snippets` type-checks doc snippets) — TanStack now ships AI-agent-consumable docs *inside the npm package*.
- Shared config lives in the separate [TanStack/config](https://github.com/TanStack/config) repo: `eslint-config`, `vite-config`, `typedoc-config`, `publish-config`.

#### 2.2 TanStack Query (the older, dual-format setup)

- Same skeleton: pnpm 11 + Nx 22 + Changesets + sherif + knip + publint + size-limit + `@tanstack/vite-config`.
- **Builds: tsup 8**, dual ESM/CJS with `build/modern` + `build/legacy` outputs; consequently `test:build` = `publint --strict && attw --pack` ([Are the types wrong](https://arethetypeswrong.github.io)) because dual format is where type-resolution bugs live.
- The package census shows how an ecosystem grows around a core without touching it: `query-core`, `query-persist-client-core`, per-framework `*-query`, `*-query-devtools`, `*-query-persist-client`, `query-sync-storage-persister`, `query-async-storage-persister`, `eslint-plugin-query`, `query-codemods`, `query-test-utils` ([TanStack/query](https://github.com/TanStack/query)).
- **Devtools pattern worth stealing**: `@tanstack/query-devtools` is a framework-agnostic UI **built once in Solid** (compiled to framework-free JS); the per-framework devtools packages are trivial embeds ([Query devtools docs](https://tanstack.com/query/v5/docs/framework/devtools)). This is the proven answer to "how do we ship prebuilt toolbars/menus without N framework rewrites."

#### 2.3 TipTap and BlockNote tooling (for contrast)

- TipTap: pnpm + **Turborepo 2.9** + Changesets; linting/formatting migrated to **oxlint + oxfmt**; tsup builds; dual ESM/CJS ([ueberdosis/tiptap](https://github.com/ueberdosis/tiptap)).
- BlockNote: builds with **Vite Plus** (`vp dev` / `vp build` / `vp test`) and **tsgo** (TypeScript's native compiler preview) for d.ts — bleeding edge, works, but the takeaway is that everyone converged on "Vite-family bundler + Vitest + Changesets + pnpm" ([TypeCellOS/BlockNote](https://github.com/TypeCellOS/BlockNote)).

### 3. TipTap: what to copy, where it leaks

TipTap v3 (current: 3.29.x) is the closest thing to a TanStack-style editor SDK ([What's new](https://tiptap.dev/docs/resources/whats-new)):

**What to copy**

- `@tiptap/core` is genuinely framework-free (dep-wise) and headless; the `Editor` runs server-side with `element: null` (SSR without a view).
- **`@tiptap/pm`**: a single package that re-exports every `prosemirror-*` module. This exists because ProseMirror's many small packages caused version-duplication hell (two copies of `prosemirror-model` = broken schema instanceof checks). One wrapper package = one pinned, deduplicated dependency surface. If we build on any multi-package substrate (ProseMirror, Yjs), this pattern is mandatory.
- **Framework-agnostic JSX**: v3 lets extensions write `renderHTML` in JSX *without React* — `@tiptap/core` ships its own `jsx-runtime` / `jsx-dev-runtime` subpath exports (verified in its package.json). Vanilla core, JSX ergonomics.
- **`@tiptap/static-renderer`**: renders document JSON → HTML / Markdown / React elements with **no editor instance and no ProseMirror schema instantiation** ([Static Renderer docs](https://tiptap.dev/docs/editor/api/utilities/static-renderer)). A read-path that bypasses the editor entirely is exactly what a "storage readable without the tool" philosophy needs.
- One extension = one package (`extension-bold`, `extension-table`, …), aggregated by `starter-kit`. Fine-grained, tree-shakeable, independently versioned via Changesets.
- `@tiptap/react` peer-deps on `@tiptap/core` + `@tiptap/pm` (not hard deps) so the app controls the single core instance; it bridges state with `use-sync-external-store` — same trick as TanStack.

**Where it leaks**

- **Per-framework extension forks**: `extension-drag-handle`, `extension-drag-handle-react`, `extension-drag-handle-vue-2`, `extension-drag-handle-vue-3` — one feature, four packages, because the extension's UI wasn't separated from its logic. Same for `extension-bubble-menu`/`extension-floating-menu`, which embed DOM/positioning behavior in the "headless" layer. Every feature that needs UI multiplies by the number of frameworks.
- **React node views are a bolt-on bridge with sharp edges** ([React node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)): `ReactNodeViewRenderer` mounts components inside ProseMirror-owned DOM via `NodeViewWrapper`/`NodeViewContent`, but the wrapper tag "must not change during runtime", node views don't re-render on position/decoration changes by default, and opting into position tracking "can impact performance". The DOM-ownership contract was never designed first-class; each binding rediscovers it.
- Commands typing via global `declare module` augmentation — all loaded-or-not extensions pollute one global interface.

### 4. BlockNote: what to copy, where it leaks

BlockNote is a Notion-style block editor on TipTap/ProseMirror — our closest prior art ([TypeCellOS/BlockNote](https://github.com/TypeCellOS/BlockNote)).

**What to copy**

- **`@tanstack/store` inside the editor core** (verified: `@blocknote/core` depends on `@tanstack/store` 0.7.7) — independent validation that TanStack Store is the right reactive substrate for an editor.
- **UI element controllers as headless stores**: each UI element (formatting toolbar, link toolbar, side menu, suggestion/slash menu, file panel, table handles) is "backed by an extension that exposes a store tracking visibility, position, and element-specific data"; any framework can subscribe and render its own UI ([Vanilla JS docs](https://www.blocknotejs.org/docs/getting-started/vanilla-js)). This is the correct headless decomposition of editor chrome.
- **UI-kit packages separate from the binding**: `@blocknote/react` (logic + default UI) vs `@blocknote/mantine` / `@blocknote/ariakit` / `@blocknote/shadcn` (theme/kit skins). Styling ecosystems get their own packages; core and bindings stay unopinionated.
- Subpath exports for optional capability areas: `./comments`, `./blocks`, `./locales`, `./extensions`, `./yjs` — with **Yjs as an optional peerDependency**, so non-collaborative users install nothing.
- `@blocknote/server-util` for server-side conversion — the "document processing without a browser" package.

**Where it leaks**

- **React-only in practice.** Official bindings: React. No Vue, no Svelte. All real UI components live in `@blocknote/react` (deps: `@floating-ui/react`, `@tanstack/react-store`, `@tiptap/react`). The docs say it plainly: *"We recommend using BlockNote with React so you can use the built-in UI components... this is not recommended as you'll lose the great out-of-the-box experience"* ([Vanilla JS docs](https://www.blocknotejs.org/docs/getting-started/vanilla-js)). The headless story exists but is the discouraged path — so it decays.
- **Core isn't clean**: `@blocknote/core` has `sideEffects: ["*.css"]` and ships stylesheets + fonts, and depends on `emoji-mart` (a UI picker dataset/library) and shiki types. Every consumer pays for UI decisions in the "headless" layer.
- **Multi-column is an add-on, not schema**: `@blocknote/xl-multi-column` is a separate package under GPL-3.0 + commercial dual licensing ([BlockNote pricing](https://www.blocknotejs.org/pricing)) — a signal that their base document model didn't accommodate columns, and that the license boundary runs through features users consider core.
- Inherits the full TipTap+ProseMirror dependency pyramid in core (`@tiptap/*`, seven `prosemirror-*` packages), so schema-level consumers (e.g., a converter) still drag in the whole editing stack.

### 5. Where the DOM view sits for an editor (the question tables never had to answer)

TanStack Table can be fully headless because *rendering a table is cheap and idiomatic in every framework* — the adapter renders `<td>`s from core-computed models. An editor is different: the view is a `contenteditable` surface with input handling, IME/composition, selection sync, paste/drag, and DOM mutation observation. No framework renders this well through its own reconciler — React fighting contenteditable is a famous tar pit.

The precedent is ProseMirror itself: [`prosemirror-view`](https://prosemirror.net/docs/ref/#view) is an **imperative vanilla-DOM component** ("displays a given editor state in the browser DOM, and handles user events") and *every* framework binding — `@tiptap/react`, `@tiptap/vue-3`, BlockNote — wraps that one view rather than re-rendering documents through the framework. Framework involvement is confined to (a) owning the mount element's lifecycle and (b) rendering *custom node views* (interactive blocks) into DOM slots the view controls — React portals in `ReactNodeViewRenderer`, and equivalents in Vue.

So for an editor SDK, the TanStack layering translates to **three** layers, not two:

1. **Headless core** (state, schema, commands, selection, history) — the analog of `table-core`; runs in Node/workers/tests with zero DOM.
2. **Vanilla DOM view** — shared infrastructure used by *all* bindings, analog of `prosemirror-view`. This is not a "vanilla adapter"; it is *the* view. (TanStack has quietly conceded this class exists: `examples/vanilla`, and `query-devtools` building its whole UI once in compiled Solid and wrapping it per framework.)
3. **Framework adapters** — lifecycle/ownership + reactive projection + custom-block component bridge. Thin by construction, like `react-table`.

---

## Pitfalls

What prior art teaches us **not** to do:

1. **Don't let the host framework's mental model into core.** Table v8's core made React-ish assumptions (options/state snapshots, memo-friendly stable references); undoing it required a ground-up v9 rewrite four years later. Core must be designed against a neutral reactivity *contract*, with the default implementation injected ([V9 reactivity blog](https://tanstack.com/blog/tanstack-table-v9-reactivity)).
2. **Don't wrap methods to fake reactivity.** V8's proxy wrappers created O(R×C×N) reactive surfaces, hid dependencies, and broke React Compiler. Reactivity belongs at the data level (atoms per state slice), beneath a stable method API.
3. **Don't fork features per framework.** TipTap's `extension-drag-handle{,-react,-vue-2,-vue-3}` quartet is the failure mode: when a feature's UI isn't split from its logic, every framework gets a diverging copy. Feature logic must be headless (a store of visibility/position/data); one vanilla-DOM default renderer; adapters only re-skin if they want.
4. **Don't ship UI in the "headless" package.** BlockNote core's CSS side effects and `emoji-mart` dependency mean *every* consumer pays for UI choices. Chrome (toolbars/menus) belongs in optional packages.
5. **Don't make vanilla the discouraged path.** BlockNote documents vanilla usage as "not recommended". Whatever path your own bindings use is the path that stays healthy — so the bindings must consume the same public vanilla API (dogfooding), or vanilla rots.
6. **Don't expose a multi-package substrate raw.** ProseMirror's package granularity causes duplicate-instance breakage; TipTap had to create `@tiptap/pm` to pin and re-export it. If we depend on Yjs/ProseMirror-like stacks, wrap them in exactly one package and make them optional peers where possible.
7. **Don't use global declaration merging for extensibility typing.** TipTap's global `Commands` augmentation and Table v8's meta merging make types lie (APIs typed as present when the feature isn't loaded). V9's per-instance generics + feature-gated types are the model.
8. **Don't ship packages without packaging CI.** Broken `exports`/types resolution is endemic; that's why every TanStack package runs `publint --strict` (and Query, being dual-format, also `attw --pack`) as a *test target*. Dual ESM/CJS is the main source of this bug class — Table v9 simply went ESM-only.
9. **Don't let the monorepo drift.** Version mismatches across workspace packages (sherif), dead exports (knip), silent bundle growth (size-limit budgets, 25KB on table-core) are all automated, not reviewed by humans.
10. **Don't leave the DOM-ownership contract implicit.** TipTap's React node views accumulate caveats (immutable wrapper tag, no re-render on position/decoration change, perf-costly position tracking) because who-owns-which-DOM was retrofitted. Define slot ownership (view owns structure + contenteditable regions; framework owns leaf component interiors) as a first-class API from day one.
11. **Don't blur license boundaries through the feature set.** BlockNote's `xl-*` GPL/commercial split lands on features users perceive as table-stakes (multi-column, exporters). If we ever dual-license, the boundary must not cut through the core document model.

---

## Recommendations for our editor

### R1. Adopt the v9 reactivity architecture wholesale

- Use `@tanstack/store` as the core's only runtime dependency (BlockNote and Table both do; it's tiny and framework-adapters already exist for react/vue/svelte/solid/angular/lit).
- Depend on it through our own injected `ReactivityBindings` contract (`createWritableAtom` / `createReadonlyAtom` / `batch` / `schedule` / `untrack`), default implementation exported at `@x/core/store-bindings` — so signal frameworks can substitute native primitives later, and so a future Swift port has a spec, not a JS dependency, to mirror.
- One atom per state slice (doc, selection, active marks, per-UI-element controller state), derived atoms for computed views. Never proxy-wrap methods.

### R2. Package graph

```
                    ┌──────────────────┐
                    │  @tanstack/store │   (only external dep of core)
                    └───────▲──────────┘
                            │
            ┌───────────────┴───────────────┐
            │            @x/core            │  schema (blocks/inline/columns/page-links),
            │  state atoms · transactions · │  document tree, commands, selection model,
            │  commands · history · queries │  undo history, block registry, UI-element
            └───▲───────▲──────────▲────────┘  controller stores. ZERO DOM APIs.
                │       │          │
   ┌────────────┴──┐ ┌──┴───────┐ ┌┴──────────────┐
   │    @x/dom     │ │@x/markdown│ │  @x/sqlite    │   persistence/codecs depend on
   │ THE view:     │ │ (+ CSV in │ │ (workspace    │   core ONLY — never on @x/dom.
   │ contenteditable│ │ @x/csv)  │ │  store)       │   This is what keeps CLI/server/
   │ renderer, input│ └──────────┘ └───────────────┘   Swift/Obsidian paths open.
   │ keymaps, paste,│
   │ drag, deco,    │      ┌───────────────┐
   │ block slots    │      │  @x/collab    │  Yjs binding; yjs = optional peer
   └───▲──▲──▲──────┘      └───────────────┘  (BlockNote pattern)
       │  │  │
 ┌─────┴┐┌┴────┐┌┴──────┐
 │@x/   ││@x/  ││@x/    │   mounts: lifecycle/ownership, reactive projection
 │react ││vue  ││svelte │   (via @tanstack/react-store etc.), custom-block
 └──────┘└─────┘└───────┘   component bridge (portal/Teleport/mount into slots)

 @x/blocks-database, @x/blocks-media, …  each with two entries:
   "@x/blocks-foo"      → schema + commands + serialization   (deps: @x/core)
   "@x/blocks-foo/dom"  → default vanilla renderer            (deps: @x/dom)
```

Dependency rules (enforce with sherif + an eslint boundary rule):

- `@x/core` imports nothing but `@tanstack/store`. No `document`, no `window` (lintable).
- `@x/dom` imports `@x/core`. Framework adapters import `@x/dom` (+ their `@tanstack/*-store`), never each other, and peer-dep their framework (`react >= 18` style, wide ranges).
- Persistence (`@x/markdown`, `@x/csv`, `@x/sqlite`) imports `@x/core` only. A static read-path renderer (TipTap `static-renderer` analog, JSON→HTML/MD without an editor instance) belongs here too.
- Block packages split schema-entry vs `/dom`-entry via subpath exports, so a server importing `@x/blocks-database` for CSV export never loads a renderer.
- **Columns and nesting live in `@x/core`'s schema, not a plugin** — BlockNote's `xl-multi-column` retrofit is the cautionary tale, and columns-in-core is one of our stated differentiators.

### R3. The vanilla DOM view is the core view — adapters are mounts

Answering the open question directly: **yes**. `@x/dom` is the single shared renderer (the `prosemirror-view` role), and framework packages do only three jobs: (1) create/destroy the view with the host's lifecycle (React `useEffect`/ref, Vue `onMounted`, Svelte attachment), (2) project editor state into framework reactivity via the existing `@tanstack/*-store` adapters, (3) render user-supplied custom-block components into DOM slots that `@x/dom` owns, via portals/Teleport/`mount()`. Specify the slot contract explicitly (view owns block structure, wrapper element, and contenteditable text regions; the framework component owns only its interior; stable wrapper tag) — this is where TipTap's React node views accumulated caveats. Default editor chrome (toolbar, slash menu, side menu, table handles) ships headless as controller stores in core (BlockNote's good idea) with default vanilla-DOM renderers in `@x/dom` (query-devtools' build-once idea) — so all frameworks get full UX for free and `@x/react` stays thin instead of becoming the product.

### R4. Monorepo setup (copy the Table v9 stack, minus what a young repo doesn't need)

- **Day one:** pnpm workspaces (`packages/*`, `examples/*`), TypeScript strict, Vitest, Changesets (+ `@changesets/changelog-github`), `publint --strict` as each package's `test:build`, sherif + knip at the root, size-limit budgets on `@x/core` and `@x/dom` (Table holds core to 25 KB; set budgets before there's something to defend), prettier or oxfmt.
- **Builds: tsdown, ESM-only.** `"type": "module"`, plain-string exports map with subpaths, `sideEffects: false`, `files: ["dist"]`, no CJS. This follows Table v9 and deletes the entire attw/dual-format problem class. (If a CJS consumer ever matters, revisit; Query shows the cost.)
- **Task runner:** plain `pnpm -r --filter` until it hurts; adopt **Nx as a dumb task graph** (Table-style: `useInferencePlugins: false`, targets = package scripts, `affected` + cache) once there are ~6+ packages and CI time matters. Turborepo (TipTap's choice) is an acceptable simpler alternative; Nx is what both TanStack flagships use.
- **Examples as workspace packages** per framework from the first adapter — including `examples/vanilla` *first*, because it is the proof the headless claim holds. Wire workspace `overrides: workspace:*` so examples always exercise local sources; consider Query's custom exports condition for a build-free inner dev loop.
- **Docs in-repo**: `docs/` Markdown with `config.json` manifest, `docs/framework/<name>/` subtrees for adapter-specific pages, generated API reference (typedoc) later. Copy the repo README into each package on publish.
- **Types policy:** generics parameterized by the block schema (BlockNote/Table pattern), per-instance — never global declaration merging; feature/block APIs should be absent from types when not registered. Add Query-style multi-TS-version `test:types` once there are external consumers.
- Adopt pnpm's supply-chain settings early (`minimumReleaseAge`, build-script allowlist) — near-zero cost, and Table treats them as table stakes in 2026.

### R5. Thinness as a testable invariant

Each adapter's `package.json` dependency list is the contract: `@x/react` = `@x/dom` + `@tanstack/react-store`, nothing else, framework as peer. CI can literally assert this. The moment an adapter needs a third dependency, the feature it's building belongs one layer down.

---

## Sources

- [Announcing TanStack Table V9 — TanStack Blog](https://tanstack.com/blog/announcing-tanstack-table-v9)
- [Inside TanStack Table V9 Reactivity — TanStack Blog](https://tanstack.com/blog/tanstack-table-v9-reactivity)
- [TanStack Table Docs — Overview](https://tanstack.com/table/latest/docs/overview)
- [TanStack/table repo (root package.json, nx.json, pnpm-workspace.yaml, packages/*/package.json, examples/, docs/)](https://github.com/TanStack/table)
- [TanStack/query repo (root + query-core + react-query + svelte-query package.json)](https://github.com/TanStack/query)
- [TanStack/store repo](https://github.com/tanstack/store) · [Store quick start](https://tanstack.com/store/latest/docs/quick-start) · [Store docs overview](https://tanstack.com/store/latest/docs)
- [TanStack/config repo (eslint-config, vite-config, typedoc-config, publish-config)](https://github.com/TanStack/config)
- [TanStack Query Devtools docs (Solid-built framework-agnostic devtools)](https://tanstack.com/query/v5/docs/framework/devtools)
- [ueberdosis/tiptap repo (packages/, core & react package.json, turbo.json)](https://github.com/ueberdosis/tiptap)
- [Tiptap Docs — What's new (v3)](https://tiptap.dev/docs/resources/whats-new)
- [Tiptap Docs — Static Renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer)
- [Tiptap Docs — React node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)
- [TypeCellOS/BlockNote repo (packages/, core & react package.json)](https://github.com/TypeCellOS/BlockNote)
- [BlockNote Docs — Usage Without React (Vanilla JS)](https://www.blocknotejs.org/docs/getting-started/vanilla-js)
- [BlockNote — Pricing / XL dual licensing](https://www.blocknotejs.org/pricing) · [XL Commercial License](https://www.blocknotejs.org/legal/blocknote-xl-commercial-license)
- [ProseMirror reference — prosemirror-view](https://prosemirror.net/docs/ref/#view)
- [publint](https://publint.dev) · [Are the types wrong (attw)](https://arethetypeswrong.github.io) · [sherif](https://github.com/QuiiBz/sherif) · [knip](https://knip.dev) · [changesets](https://github.com/changesets/changesets) · [tsdown](https://tsdown.dev)
