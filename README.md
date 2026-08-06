# notion-block-editor (working name)

A Notion-class block editor for the browser, written in vanilla TypeScript.
Headless core, thin framework bindings (TanStack philosophy), and storage you
can read without the tool: Markdown, CSV, SQLite.

**Status: Phase 1 in progress.** The headless core (block model, invertible
operations, history, commands — fully unit-tested) and a first DOM view
(per-block contenteditable, autoformat, keymap, selection sync) are working.
The architecture is derived from ~40k words of source-backed research on
Notion's internals, contenteditable's failure modes, ProseMirror/Lexical/Slate,
Gutenberg, BlockNote, TipTap, storage interop, and CRDT futures.

## Getting started

```sh
pnpm install
pnpm dev        # live demo with a JSON/transaction inspector → http://localhost:5173
pnpm test       # headless op-layer tests (vitest)
pnpm typecheck
```

## Principles

1. **The model is the document.** The DOM is a disposable projection of a
   canonical JSON block tree. Every serious editor since 2014 works this way.
2. **Every mutation is an operation.** A closed set of serializable, invertible
   ops batched into transactions. This one decision buys undo/redo, the
   extension API, the test harness, the storage log, and the future CRDT
   boundary.
3. **Headless core, one vanilla DOM view, thin mounts.** Framework adapters do
   three jobs only: lifecycle, state projection, custom-block portals. Their
   dependency lists are a CI-tested invariant.
4. **File over app.** Delete the app; the workspace folder must still show
   every page, database row, and view in a text editor. Markdown/CSV are
   deterministic projections with a documented, tested loss boundary.
5. **CRDT-shaped, CRDT-free.** v1 has zero collab code, but stable block IDs,
   op-shaped mutations, and identity-based anchors make the future retrofit
   cheap (Notion paid a decade for skipping this).
6. **Accessibility is architecture,** not polish: the Navigation/Edit keyboard
   model is the same state machine as block selection (the Gutenberg lesson).
7. **No over-engineering.** Every abstraction pays rent. Columns and nesting
   are in the core schema (can't be retrofitted); virtualization, plugins
   marketplaces, and CRDTs are not (can be).

## Repository map

```
docs/
  ARCHITECTURE.md    the design: model, pipeline, packages, storage, decisions
  ROADMAP.md         phases: spikes → editor → SDK → databases → storage → collab/native
  research/          8 source-backed research notes the design is derived from
packages/
  core/              headless: schema, block store, 7 invertible ops, transactions,
                     history with coalescing, commands, autoformat. Zero DOM.
  dom/               the editor view: per-block contenteditable leaves, rendering,
                     input (beforeinput + IME reconciliation), keymap, selection sync
examples/
  vanilla/           live demo — the editor plus a document/transaction inspector
```

Coming next (see ARCHITECTURE.md §9 and ROADMAP.md): `packages/{react,vue,svelte}`,
`packages/markdown`, `packages/sqlite`, block chrome (slash menu, drag handle).
