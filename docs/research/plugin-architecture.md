# Plugin architecture — what Tiptap does, what we do, and what we should do

Research note, 2026-08-07. Sources: Tiptap extension API docs (fetched, not
recalled), and a full read of our own packages at commit `1cad4fc`.

---

## 1. The measurement that starts this

Adding one block type to this editor today touches **14 files across 4
packages**. Measured, not estimated — `callout` appears in:

```
core/src/schema.ts              register the spec
dom/src/render.ts               a case in switch (block.type)
dom/src/block-actions.ts        the ⋮⋮ menu entries
dom/src/block-types.ts          the "Turn into" table
dom/src/callout.ts              its presets
dom/src/caret.ts                a selector in the click-routing list
dom/src/clipboard.ts            paste mapping
dom/src/controls.ts             gutter eligibility
dom/src/input.ts                delegated click handling
dom/src/slash.ts                the ITEMS array
dom/src/style.css               its styles
dom/src/ui/icon-picker.ts       its icon affordance
markdown/src/index.ts           serialize + parse
static-renderer/src/index.ts    HTML projection
```

There are **18 closed `switch`/`===` dispatches on `block.type`** across the
source. Every one of them is a place a third-party block cannot reach.

This is not rot — it is what building the block set first, fast, looks like.
But it is now the binding constraint on everything the roadmap calls
"ecosystem", and it is why this note exists.

## 2. What Tiptap actually does

Tiptap's unit of extension is a single object literal with lifecycle hooks:

```ts
const CustomExtension = Extension.create<Options>({
  name: 'customExtension',
  addOptions() { return { customOption: 'default value' } },
  addCommands() { return { customCommand: () => ({ commands }) => … } },
  addKeyboardShortcuts() { return { 'Mod-k': () => … } },
  addProseMirrorPlugins() { return [new Plugin({ key: new PluginKey('…') })] },
})
```

Activation is an import plus an array entry — nothing else:

```ts
new Editor({ extensions: [StarterKit, Highlight] })
```

Four properties of that design are worth stealing:

1. **Activation is an import.** Not importing an extension means it is not in
   the bundle. Tree-shaking is the feature, not an optimization.
2. **One object owns everything about the feature** — schema, commands, keys,
   view behaviour. You read a feature in one file.
3. **`StarterKit` is a bundle, not a core.** The default experience is a
   curated list, and it is removable. Nothing is privileged.
4. **`.configure()` per instance.** Options are per-editor, not global.

`Node.create` / `Mark.create` are the same shape plus `parseHTML`,
`renderHTML`, `addNodeView` — i.e. a node is an extension that also knows how
to become DOM and how to come back from it.

## 3. Where we already agree, and where we don't

**We already have the declarative half, and it is per-instance.** `Schema` is
an ordinary object owned by an `Editor` (`new Editor({ schema })`), and
`BlockSpec` is JSON-serializable by design — §4 of ARCHITECTURE calls it "the
single extension point", and the Swift port is supposed to consume the same
registry. That part is right and does not need redesigning.

**What is missing is that the behavioural half never travels with the spec.**
`BlockSpec` carries `type`, `version`, `inline`, `layout`, `defaultProps`,
`placeholder` — and stops. Rendering, keys, menu actions, paste mapping and
both projections live in closed switches somewhere else. So the registry is
open in principle and closed in practice: registering a spec the renderer has
never heard of produces a block that draws nothing.

**Two registries are already global mutable state.**
`dom/src/block-actions.ts` and `dom/src/block-toolbar.ts` hold module-level
`Map`s populated by import-time side effects. Two editors on one page share
them; per-instance block sets are impossible; and the registration order
depends on import order. These are the right *idea* — a registry rather than a
switch — implemented at the wrong scope. They should become per-editor and
they are the natural seed of the plugin API.

**Where Tiptap's design does not transfer.** Tiptap has exactly one output:
HTML, via `renderHTML`. We have **three projections plus paste**:

| surface | package | today |
|---|---|---|
| editing DOM | `dom/render.ts` | closed switch |
| markdown (L1, the storage promise) | `markdown/index.ts` | closed switch, both directions |
| static HTML (export/SSR) | `static-renderer/index.ts` | closed switch |
| clipboard HTML → blocks | `dom/clipboard.ts` | closed switch |

This is the hard part of our plugin story, and copying Tiptap wholesale gets
it wrong. A block that renders in the editor but not in markdown silently
breaks the file-over-app promise — a user's document loses content on export,
which is the one failure this project exists to prevent. So **a plugin must be
able to contribute to every projection, and the projections must be honest
about a block they do not know.**

Corollary: `markdown` and `static-renderer` depend on `core` and must never
depend on `dom` (§9, CI-enforced). A plugin therefore cannot be one module —
it has to be split by entry point, which §9 already anticipates:
`blocks-*    schema entry (deps: core) + /dom renderer entry (deps: dom)`.

## 4. The shape that fits us

A block plugin is a **manifest split across subpath entries**, assembled per
editor instance:

```ts
// @nbe/blocks-callout            → deps: core only
export const calloutSpec: BlockSpec = { type: 'callout', version: 1, … }

// @nbe/blocks-callout/dom        → deps: dom
export const calloutDom: BlockView = {
  render(ctx, block) { … },        // replaces a case of render.ts
  actions(ctx) { … },              // replaces registerBlockActions
  keys: { Enter: … },              // replaces a branch of keymap.ts
  slash: { label: 'Callout', … },  // replaces an ITEMS entry
  styles: '…',                     // its own CSS, not a slice of style.css
}

// @nbe/blocks-callout/markdown   → deps: markdown
export const calloutMarkdown: BlockProjection = {
  toMarkdown(block, ctx) { … },
  fromMarkdown: [{ match: /^> \[!(\w+)\]/, parse: … }],
}
```

and activation stays an import plus an array, Tiptap-style:

```ts
const editor = new Editor({ blocks: [starterBlocks, callout.configure({ … })] })
new EditorView(el, editor, { blocks: [starterDom, calloutDom] })
```

Three deliberate differences from Tiptap:

- **The spec stays JSON-serializable and separate from behaviour**, because the
  Swift port and the static renderer consume the spec without any JS
  behaviour. Tiptap can conflate them; we cannot.
- **Projections are first-class, not an afterthought.** A `BlockProjection`
  that omits `toMarkdown` makes the block export as an
  `<!-- nbe:type -->` marker — which `markdown/index.ts` already does for
  unknown types. Lossy, but never silent.
- **No `addProseMirrorPlugins` equivalent for a while.** Tiptap needs an escape
  hatch into PM's plugin system because PM owns the view. Our view is ours; an
  escape hatch that hands out raw DOM control would immediately become the API
  everyone uses and we could never change the renderer again. Behaviour
  plugins (non-block features like the slash menu itself) are a separate,
  later decision — see §6.

## 5. Two kinds of plugin, and only one is urgent

It is worth separating what "plugin" means here, because conflating them is
how this gets over-built:

**Block plugins** — a new block type. Bounded, well-understood, and the thing
the 14-file measurement is about. There is a known list of contribution points
because we wrote all 14 of them ourselves.

**Feature plugins** — the slash menu, drag & drop, the selection toolbar,
cross-block selection. Today these are 12 hardwired `attach*(view)` calls in
`view.ts`. They are *already* structured as plugins in everything but name:
each takes the view and returns an unbind function. Turning that array into an
option is nearly free:

```ts
new EditorView(el, editor, { features: [slashMenu, dragAndDrop, …] })
```

but doing it *well* means deciding what a feature may depend on, how two
features contend for the same key or the same pointer gesture, and what the
ordering guarantees are. That is genuine design work with no forcing function
yet. The cheap version (an array of the existing `attach*` functions, ordered,
with no contention story) is worth doing because it makes the editor
tree-shakeable and honest about what is optional — and it costs almost
nothing, because the functions already have the right signature.

## 6. What this does *not* justify

- A generic event bus, priority system, or plugin lifecycle beyond
  `attach → unbind`. ProseMirror needs priorities because plugins intercept a
  shared transaction pipeline; ours mostly attach independent listeners.
- A plugin *distribution* story (registry, versioning, sandboxing). That is
  Phase 5, and it needs a second author before it means anything.
- Rewriting `core`. The op layer, history and commands are type-agnostic
  already — the closed switches are all in the view and projection layers.

## 7. The CSS question, which is the same question

`dom/src/style.css` is 1628 lines in one file, and it is where a block's
appearance lives — so a block plugin cannot own its own look. It has the same
shape of problem as the TypeScript: one closed artifact that every feature has
to be edited into.

The token layer added on 2026-08-06 is the half of this that is already right:
every colour resolves from six base channels plus the named palette, so
theming is a token override rather than a rule override. What is missing is
*partitioning*: block styles, chrome styles (gutter, menus, toolbars) and the
UI primitive styles are interleaved by accident of writing order, not
separated by ownership.

The split that matches the code:

```
style/reset.css        the leaf/contenteditable substrate
style/tokens.css       the token block + themes  (already coherent, just extract)
style/blocks.css       per block type — candidates to move into block plugins
style/chrome.css       gutter, drop guides, selection overlays
style/ui.css           menu, tooltip, popover, dropzone, icon picker — the primitives
```

with `@nbe/dom/style.css` importing them in order, so today's single import
keeps working. The interesting outcome is that `blocks.css` should mostly
*empty itself* into the block plugins as they are extracted — which is the
test of whether the extraction is real.

## 8. The UI primitives, seen honestly

`dom/src/ui/` already is a small component kit: `position` (floating
placement + autoUpdate + dismissal), `menu`, `tooltip`, `hover`, `drag`,
`ghost`, `upload`, `icon-picker`, `action-button`. That is the right idea and
it is the layer the rest of the editor is built on.

What it is missing, measured against what the editor already needs and
re-implements ad hoc:

- **form controls** — `database.ts` hand-rolls `inlineInput` (99 lines) and a
  bare `select`; the icon picker hand-rolls its search field. There is no
  shared text input, no select, no checkbox, no segmented control.
- **validation / feedback** — the formula editor has its own status and error
  lines; nothing else can reuse them.
- **popover vs menu** — `menu.ts` is both a menu and the generic popover, so
  every non-list overlay (the drop zone, the formula editor) passes a
  `{kind: 'custom', el}` entry to pretend to be a menu item.
- **field + label + hint** composition, which is why the database property
  panels are laid out by hand.

This is the part of the refactor with the clearest payoff: `database.ts` is
957 lines, and a large fraction of it is UI plumbing that a real primitive
layer would delete rather than move.

## 9. Sequencing constraint worth stating once

The presentation site documents the public API. The refactor changes the
public API. Building both at full speed simultaneously means writing the API
reference twice and shipping a site that is wrong the day the refactor lands.

The site's *architecture, design, concept pages and philosophy* do not depend
on the API surface. Its *API reference and integration snippets* do. So the
site starts now and its reference section is written last — after the plugin
API settles — rather than the site waiting or the reference being written
twice.
