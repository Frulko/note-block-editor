# Carnet

A Notion-class block editor written in vanilla TypeScript, with storage you can
read without it: Markdown files in a folder, the way Obsidian does it.

The gap it aims at is narrow and, as far as a 2026 survey of the field could
tell, unoccupied: **nobody offers Notion-grade WYSIWYG editing whose storage is
plain Markdown files.** Obsidian has the files and a text editor with
decorations; Notion has the editing and an export that loses your databases.
See `docs/research/competitive-landscape.md` for who fails at which half.

**Status: phases 1–5 shipped.** Working today:

- **The editor** — headless core (flat block map, seven invertible operations,
  coalescing history), a DOM view with per-block `contenteditable` leaves,
  IME-safe input, slash menu, hover controls, in-house pointer drag with
  columns, block selection and a three-format clipboard.
- **Databases** — table, board, list and gallery views, grouping,
  multi-filter/sort, a pure formula language, relations, rollups, and
  CSV/Markdown/`.base` projections.
- **A workspace** — page tree, backlinks, search, and a Markdown vault that
  round-trips: export it, edit it in Obsidian, import it back with ids intact.
- **Collaboration** — Loro CRDT, comments anchored to text rather than offsets,
  document history with restore, live carets, and `nbe serve`: a headless node
  you can run on a NAS.
- **Peer-to-peer over WebRTC** — the relay negotiates the connection and then
  stops carrying the document. It doubles as the fallback, so there is no TURN
  server to host: one port, one service, and a status line that says which path
  is live. Why not "fully p2p", and what any-sync does instead:
  `docs/research/p2p-any-sync.md`.
- **Five clients** — the web editor, a Tauri desktop app, an iOS app, an
  Obsidian plugin (the editor alone: no comments, no sync), and a Swift package
  that reads *and writes* the same CRDT document. A browser, an iPhone and a
  command line hold one document with the relay out of the path.

**Six gating test suites**: ~870 unit tests, Chromium, WebKit (Safari's engine),
an alternative editable topology, touch at phone viewports, and the Swift port.

The architecture is derived from ~40k words of source-backed research on
Notion's internals, contenteditable's failure modes, ProseMirror/Lexical/Slate,
Gutenberg, BlockNote, TipTap, storage interop, and CRDTs.

## Getting started

```sh
pnpm install
pnpm dev        # live demo with a JSON/transaction inspector → http://localhost:5173
pnpm test       # unit tests (vitest)
pnpm typecheck
pnpm e2e        # the browser matrix: Chromium, WebKit, and touch viewports

TOPOLOGY=single-host pnpm e2e            # the alternative editable boundary
pnpm --filter demo-collab dev            # two peers sharing one document
cd native/swift && swift test            # the Swift port
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
5. **CRDT-shaped before CRDT-carrying.** Stable block ids, op-shaped mutations
   and identity-based anchors came first, which is what made adopting Loro a
   package rather than a rewrite. Tana's post-mortem for a full rebuild is one
   sentence: collaboration is not a layer you bolt on at the end.
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
  TESTING.md         the browser matrix, and what still needs a real device
  NEXT.md            measured state, open questions, and the traps
  research/          8 source-backed research notes the design is derived from
packages/
  core/              headless: schema, block store, 7 invertible ops, transactions,
                     history, commands, autoformat, database engine. Zero DOM.
  dom/               the editor view: contenteditable leaves, input/IME, keymap,
                     caret authority, clipboard, drag & drop, UI primitives
  blocks-callout/    a block plugin: schema, view, both projections, one package
  blocks-table/      the table as a plugin: three block types, its geometry,
                     merged cells, cell selection, its own CSS
  markdown/          block JSON ↔ markdown; /collections projects databases
                     to CSV, one .md per row, and .base view files
  static-renderer/   block JSON → HTML with no editor instance (SSR/CLI safe)
  react/ vue/ svelte thin mounts: lifecycle, projection, hosting. Nothing else.
  workspace/         the notes app: page tree, backlinks, search, Markdown vault,
                     Notion import, collections. Zero DOM.
  collab/            Loro CRDT: block store, text merging, sync transport,
                     WebRTC mesh, presence, comments, document history
  cli/               `nbe` — the vault from a terminal, an SQLite index,
                     `nbe relay`/`nbe serve` (relay, signalling, sync node) and
                     `nbe peer`, a headless WebRTC peer
apps/
  desktop/           Carnet as a Tauri app: a vault in a folder you choose
  ios/               the third client, in the simulator: SwiftUI + real WebRTC
  obsidian/          the editor alone, as an Obsidian view. No sync, by design
examples/
  vanilla/           full demo — multi-page workspace, databases, inspector
  collab/            two peers, one document, in one page
  react/ vue/ svelte one-file integrations, each with a live static-render pane
native/swift/        the document format and the CRDT, read and written by a
                     second implementation in another language
site/                the presentation site (Astro), with a live collaborative demo
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
