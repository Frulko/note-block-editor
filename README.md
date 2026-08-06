# notion-block-editor (working name)

A Notion-class block editor for the browser, written in vanilla TypeScript.
Headless core, thin framework bindings (TanStack philosophy), and storage you
can read without the tool: Markdown, CSV, SQLite.

**Status: Phase 1 functionally complete** (see ROADMAP for residuals). Working
today: the headless core (flat block map, 7 invertible operations, coalescing
history — fully unit-tested), the DOM view (per-block contenteditable leaves,
IME-safe input, slash menu, hover controls with block menu, pointer drag & drop
with column creation, block selection with the full Notion key contract,
three-format clipboard with schema-sanitized paste), a markdown package, and a
multi-page demo with persistence. The architecture is derived from ~40k words
of source-backed research on Notion's internals, contenteditable's failure
modes, ProseMirror/Lexical/Slate, Gutenberg, BlockNote, TipTap, storage
interop, and CRDT futures.

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
  TESTING.md         manual IME / screen-reader device matrix
  research/          8 source-backed research notes the design is derived from
packages/
  core/              headless: schema, block store, 7 invertible ops, transactions,
                     history, commands, autoformat, database engine. Zero DOM.
  dom/               the editor view: contenteditable leaves, input/IME, keymap,
                     caret authority, clipboard, drag & drop, UI primitives, tables
  markdown/          block JSON ↔ markdown (both directions)
  static-renderer/   block JSON → HTML with no editor instance (SSR/CLI safe)
  react/ vue/ svelte thin mounts: lifecycle, projection, hosting. Nothing else.
examples/
  vanilla/           full demo — multi-page workspace, databases, inspector
  react/ vue/ svelte one-file integrations, each with a live static-render pane
```

### Using the SDK

```tsx
// React
import { BlockEditor } from '@nbe/react';
import '@nbe/dom/style.css';
<BlockEditor initialContent={doc} onChange={setDoc} />
```

```vue
<!-- Vue -->
<BlockEditor :initial-content="doc" @change="onChange" />
```

```svelte
<!-- Svelte: an action, no compiled component needed -->
<div use:blockEditor={{ initialContent, onChange }} />
```

```ts
// Anywhere (SSR, CLI, static site): no editor, no DOM
import { renderToHTML } from '@nbe/static-renderer';
const html = renderToHTML(doc);
```

Adapter thinness is a CI-enforced invariant (`test/packaging.test.ts`): a
binding's dependencies must be exactly `@nbe/core` + `@nbe/dom` with the
framework as a peer — a third dependency means the feature belongs one layer
down.
