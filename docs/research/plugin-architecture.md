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

---

# Addendum — evidence from the field (2026-08-07)

A survey of Tiptap, ProseMirror, Lexical, CodeMirror 6, BlockNote, Slate and
Plate, with issue trackers and maintainer statements as sources. Three of its
findings change the plan above; the rest confirm it.

## A. Numeric priorities are a known-bad pattern — and §2.2 above proposed one

Our `GestureRecognizer` sketch carried `priority: number`. Every system that
shipped numeric priorities regrets it.

Marijn Haverbeke, on why CodeMirror 6 refused them
([Extensible Extension Mechanisms](https://marijnhaverbeke.nl/blog/extensibility.html)):
a module in isolation cannot know what numbers other modules picked — "the
options are just points on an undifferentiated numeric range". It is z-index.

The evidence:

- **Lexical** shipped five priority buckets, then discovered you could not get
  in front of an existing listener at your own level. The fix was
  `COMMAND_PRIORITY_BEFORE_*`: negative constants that `& 7` back into the same
  bucket and unshift to its front. A priority system that needed a sub-priority
  system ([#2978](https://github.com/facebook/lexical/issues/2978),
  [#6767](https://github.com/facebook/lexical/issues/6767)).
- **Tiptap** shipped the ordering *backwards* — a stray `.reverse()` meant the
  lower-priority extension won, and nobody noticed for a long time because the
  resulting order is unobservable
  ([#1547](https://github.com/ueberdosis/tiptap/issues/1547)). Array position
  also silently changes behaviour at equal priority
  ([#1154](https://github.com/ueberdosis/tiptap/issues/1154)).
- **BlockNote** ended up with three ordering systems in one stack:
  `runsBefore` over Tiptap's number over ProseMirror's array order.

**Correction:** named precedence categories (CodeMirror's
`highest/high/default/low/lowest`), then source order within a category. Our
gesture router already uses pure source order, which is the honest subset —
it should stay that way and gain named categories only if something forces it.

## B. One priority for a whole plugin is the wrong granularity

Tiptap's single `priority` governs keymaps *and* input rules *and* paste rules
*and* schema rendering at once. [#2570](https://github.com/ueberdosis/tiptap/issues/2570)
is the `#` suggestion trigger fighting the `#` heading input rule; the fix
moved the coupling rather than removing it. Marijn names this exact failure:
"if a plugin has multiple effects, you have to either hope that they all need
the same precedence relative to other plugins, or you have to split it into
smaller plugins".

**Consequence for us:** a block plugin must be *an array of tagged
contributions*, not one object with one rank — so a block can want high
precedence for its keymap and default precedence for its input rule.

## C. `starterBlocks` as planned would defeat tree-shaking

The plan above proposes `import { starterBlocks } from '@nbe/blocks'`. That is
exactly Tiptap's `StarterKit`, which statically imports ~20 extensions;
`StarterKit.configure({ heading: false })` disables it at runtime but the code
is still in the bundle. Ergonomics and tree-shaking are in direct conflict, and
the kit wins.

**Correction:** the starter set should be a *documented array literal* users
paste and edit — same ergonomics on day one, actually removable on day two.
`R6`'s exit criterion ("removing it from the array removes it from the bundle")
is only meaningful if the default set is not a barrel.

## D. Confirmations, with sharper evidence than we had

- **Projections must be exhaustive and loud.** Our §3 argument was reasoning;
  here is the failure in production. Tiptap
  [#7731](https://github.com/ueberdosis/tiptap/issues/7731): a `hardBreak`
  inside a table cell serializes to a space — `foo<br>bar` becomes `foo bar`,
  no error, no warning. Lexical is worse structurally, with **three
  unsynchronised registries** for one node — `exportJSON`, `exportDOM`, and
  markdown transformers that are not on the class at all but passed at the
  call site, so a node can render perfectly and vanish from
  `$convertToMarkdownString` with nothing able to notice.
  `prosemirror-markdown` is the counter-example: it **throws** on an unmapped
  node. Loud failure beats silent loss, and the renderer table should be
  non-optional in the type so a missing format is a compile error.
- **Markdown retrofitted is markdown broken.** Tiptap only shipped bidirectional
  markdown in October 2025, years after its extension API froze; every
  extension written before has no handler. We have markdown from the start —
  that is the asset to protect, not a detail.
- **No raw escape hatch.** Confirmed emphatically: ProseMirror's `nodeViews`
  contract is why it can no longer change when it re-renders or destroys a
  view, and every framework binding is built on it, so it is frozen. Tiptap's
  `addProseMirrorPlugins` makes `@tiptap/core` permanently a veneer. BlockNote
  leaks two levels down through `tiptapExtensions`. The rule: any API handing
  out a live DOM node or a mutable core object *becomes* the real interface.
- **Module-level keys, per-instance values.** ProseMirror's module-level
  `PluginKey` produces the long-running "Adding different instances of a keyed
  plugin" class of failure whenever two copies of a package load. Our two
  module-global registries (`block-actions`, `block-toolbar`) are the same
  mistake in miniature, and R3 already plans to fix it.

## E. One recommendation we had not considered

**Version the plugin contract separately from the library** — an `apiVersion`
on each plugin, checked at load. Three lines, and it lets v1 and v2 plugins run
side by side during a migration instead of forcing a Tiptap-style v2→v3 where
`getPos()` changing return type broke every node view author at once.

## F. The open question this raises for us

The survey's strongest structural recommendation is **renderers return data,
not DOM** — ProseMirror's `toDOM` returns `["div", {class}, 0]`, which is
inspectable, testable in Node, reusable for SSR, and leaves the renderer free
to change. Our `render.ts` returns a live `HTMLElement`.

This is not free: our renderers do real work a spec array cannot express
(drop zones, async asset resolution, database views). It also overlaps
`@nbe/static-renderer`, which already produces HTML strings from the same
blocks. Deciding this belongs with R3 and is deliberately left open here.
