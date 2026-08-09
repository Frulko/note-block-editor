# Plan — plugin architecture, refactor, and the presentation site

2026-08-07. Rationale and measurements in `docs/research/plugin-architecture.md`.

The target: **activating a feature is an import plus an array entry**, the way
Tiptap does it, without giving up the three projections that make this project
different from Tiptap.

```ts
import { Editor } from '@nbe/core'
import { starterBlocks } from '@nbe/blocks'
import { callout } from '@nbe/blocks-callout'

const editor = new Editor({ blocks: [starterBlocks, callout] })
```

---

## Track R — refactor (defines the API)

Each step lands green (231 tests today) and is independently revertable. Steps
are ordered so the risky ones inherit a cleaner base, not the reverse.

### R1 — partition the stylesheet — **done 2026-08-07** *(mechanical)*
1628 lines in one file, split by ownership into `reset / tokens / blocks /
chrome / ui`, re-exported by today's `@nbe/dom/style.css` so no consumer
changes. Prerequisite for a block plugin owning its own look.
**Done when:** the import path is unchanged and the rendered pixels are
identical. *Verified by measurement, not inspection: 109 elements × 38
computed properties, monolith vs split, identical digest — after a sentinel
rule proved the new CSS was actually being served, without which the first
comparison passed only because HMR had not applied it.*

### R2 — finish the UI primitive layer — **done 2026-08-07**
`ui/` has floating, menu, tooltip, hover, drag, ghost, upload, icon picker,
action button. It is missing the form layer, which is why `database.ts` is 957
lines: it hand-rolls `inlineInput`, bare `<select>`s, its own validation
status, and lays out property panels by hand.

Add: `field` (label + control + hint + error), `input`, `select`, `checkbox`,
`segmented`; extract a real `popover` out of `menu` (today every non-list
overlay fakes being a menu item via `{kind:'custom', el}`).
**Done when:** `database.ts` and `icon-picker.ts` are *smaller*, not merely
different — this step must delete more than it adds.

**Outcome, stated honestly.** `database.ts` went 960 → 916 lines and now
contains **zero hand-rolled form controls**, down from ten. Globally the diff
is +356 lines, because `field.ts` and `popover.ts` are new *capability* —
plugin API surface that did not exist — rather than moved code. So the line
criterion as written was the wrong measure; the one that mattered is the
control count, and it went to zero.

Split into R2a (the primitives) and R2b (converting `database.ts`) once the
evidence showed R2 was not internal comfort but plugin API surface:
`block-actions.ts` and `block-toolbar.ts`, the two registries that *become*
the plugin API, already hand-rolled their inputs. A block author with nothing
to reach for writes raw DOM, and raw DOM then is the contract.

R2b earned its place as validation rather than cleanup: converting the filter
row surfaced a bug I had just introduced — the field wrapper was created but
the raw input was appended, so the show/hide of the value field by operator
was toggling a detached element. Caught in the browser, not by the type
checker or the tests.

### R3 — per-editor block registry — **in progress 2026-08-07**
`BlockView { render, actions, keys, slash, turnInto }`, held by the view
instance rather than in module-global `Map`s. Replaces `render.ts`'s switch,
`block-actions.ts`/`block-toolbar.ts`'s import-time side effects, `slash.ts`'s
`ITEMS`, and `block-types.ts`'s `TURN_INTO`.
Built-ins move into `blocks/<type>.ts` modules and are re-exported as
`starterBlocks`, so the default experience is unchanged and removable.
**Done when:** two editors on one page can have different block sets.

**Progress.** The contract is declared *whole* in `core/plugin.ts` — schema,
view and every projection in one type — before any of it is wired, which is
the guard against Lexical's three unsynchronised registries. `BlockView` in
`dom/block-view.ts` refines the view half; `render` and `chrome` are separate
so text-shaped blocks do not each re-implement the row-and-leaf walk.

The callout is the first block extracted, and it now contributes its chrome,
gutter actions, five slash entries and its turn-into target from one file.
`render.ts`, `slash.ts`, `block-types.ts` and `block-actions.ts` no longer
mention it. What still does: `input.ts` (the delegated icon-picker click),
`clipboard.ts` (paste mapping), `schema.ts` (registration), and both
projection packages — the last two are R5, and the first two are the next
contribution points to add.

Measured: from **14 files across 4 packages** down to **7**, of which two are
stylesheets awaiting the `styles` contribution and two are the projections R5
will take.

### R4 — features as an array — **done 2026-08-07**
`view.ts`'s 12 hardwired `attach*(view)` calls become
`features: [slashMenu, dragAndDrop, …]` with today's list as the default. The
signature already matches; this is mostly moving a line. No priority system,
no contention story — deliberately, until something forces one.
**Done when:** an editor built without the slash menu does not ship it.

### R5 — projections as contributions — **done 2026-08-07**
`BlockProjection { toMarkdown, fromMarkdown, toStaticHtml, fromClipboardHtml }`
so a block can reach markdown and the static renderer without those packages
importing `dom`. Unknown types keep their existing honest fallback
(`<!-- nbe:type -->`), never silence.
**Done when:** a block type unknown to the projections round-trips lossily and
*visibly*, and a plugin can make it lossless without touching those packages.

### R6 — extract one real plugin package — **done 2026-08-07**
`@nbe/blocks-callout` with the §9 subpath split: schema entry (deps `core`),
`/dom` entry (deps `dom`), `/markdown` entry (deps `markdown`). One package,
to prove the seams are real. Not a family of them.
**Done when:** removing it from the array removes it from the bundle.

**Outcome.** `@nbe/blocks-callout` ships with the §9 split: the main entry
carries the schema and both projections and depends on `core` alone, while
`/dom` adds the view and takes `@nbe/dom` as an *optional peer*. That is what
lets `@nbe/markdown` consume the block without ever importing the editor —
the layering CI enforces, now exercised by a real package rather than asserted.

`@nbe/dom` ships **no** built-in block plugins: `builtinBlocks` is empty, and
the demo composes `blocks: [callout]` itself. Activation is genuinely an
import plus an array entry.

R5 and R6 turned out to be one step, not two: wiring the markdown projection
required the block's DOM-free half to exist as its own module, which is R6.
Trying to do R5 first would have meant either markdown importing dom, or a
temporary shim.

**Explicitly not in this track:** a plugin distribution story (registry,
versioning, sandboxing), a priority/event-bus system, or any rewrite of
`core` — the op layer is already type-agnostic.

### R8 — extract the *hard* plugin: the table — **done 2026-08-09**
The callout proved the seams for a block that is one type, one row of text and
two projections. The table is the other end of the range: three block types,
a document invariant, a geometry, chrome that lives outside its own box, a
pointer gesture that competes with text selection, and a selection that is
neither a text range nor a set of blocks. If the plugin API can hold that, it
is an API; if it cannot, the callout only proved that a simple block is simple.
**Done when:** `@nbe/blocks-table` can be removed from the arrays and nothing
in `core`, `dom`, `markdown` or `static-renderer` mentions a table.

**Outcome.** It could not, and four things had to be added. Each was forced by
the table and each is general — that is the test that a hook is an extension
point rather than a hole cut to fit one block:

| added | why the table forced it | who else wants it |
|---|---|---|
| `BlockPlugin.normalize(doc, tx)` + `Editor.plugins` / `Editor.use()` | every row must fill the same number of *slots*, counting the ones a merged cell covers; the reducer used to call `normalizeTables` by name | any block with internal structure — a column set, a database view, a future kanban. ProseMirror needs the same thing and exposes it as `fixTables` because its plugins cannot reach the apply loop |
| `BlockView.features` | hover chrome outside the block's box, and a cell-rectangle gesture that must beat text selection | any block whose interaction is more than per-block rendering. Contributes a `GestureRecognizer`, so one press still has exactly one owner |
| `BlockView.decorate` | a merged cell needs `grid-column: span n` on the element the *default* path built; `chrome` prepends and `render` replaces, neither fits | any block that wants a class or an inline style without owning its rendering |
| `BlockSpec.standalone` | the table *is* the unit you grab even though it is a container; its rows and cells are not, even though a cell carries text. `controls.ts` spelled both out by type name | any container that is itself a unit |

Three contracts that were **declared but never consulted** also had to be
wired, which is its own lesson about declaring an API before a second consumer
exists: `BlockView.keys` (the keymap never asked), `BlockView.toolbar` (the
toolbar had its own module-global registry), `SlashEntry.insert` (the slash
menu always inserted a single block), and `BlockPlugin.html` (the static
renderer never looked). All four are now the only path.

Two smaller generalizations fell out: `render.ts` reads `spec.layout` instead
of listing container type names, and the markdown parser asks a rule's `parse`
whether a line starts a construct — a GFM table is a pipe row only when the
delimiter follows, and a one-line `match` regex cannot see that.

**Measured.** `packages/dom/src/style/blocks.css` and `chrome.css` lost every
table rule to the plugin's own `styles`, which R1 called the test of whether an
extraction is real. `@nbe/markdown`, `@nbe/static-renderer`, `core/schema.ts`,
`keymap.ts`, `slash.ts`, `controls.ts`, `render.ts`, `block-actions.ts` and
`block-toolbar.ts` no longer contain the word *table*.

**What stayed behind, deliberately.** `clipboard.ts` still converts a pasted
`<table>` and a spreadsheet TSV into table blocks. Paste conversion is an
*importer* — it reads a foreign format, and its output is validated by the
schema like any other block, degrading to paragraphs when the plugin is not
registered. A `pasteRules` contribution point is the upgrade path, and it waits
for a second plugin that wants one. The table's labels also stay in
`EditorLabels`, so a host still has one i18n surface; per-plugin i18n is a
design of its own with no second claimant yet.

### R9 — the second hard plugin: the code block — **done 2026-08-09**
The table proved the API could hold a block with *structure*. The code block
asks a different question: can a plugin bring a **dependency, a rendering
technique and a palette** the editor knows nothing about?
**Done when:** `@nbe/blocks-code` owns its highlighter, its CSS and its
markdown, and `core`/`dom` are still at zero runtime dependencies.

**Outcome.** One addition to the API, and it was the one the callout and the
table had both worked around:

| added | why the code block forced it | who else wants it |
|---|---|---|
| `BlockPlugin.autoformat` + `matchAutoformat(text, plugins)` | ` ``` ` opens a code block the way `- ` opens a list, and core's table listed it by name | every block with a markdown shape. Plugin rules are consulted first, so a plugin may also claim a built-in prefix |

Everything else it needed already existed, which is the useful signal: `keys`
(Enter adds a line, Tab indents), `toolbar` (language, wrap, copy), `actions`,
`decorate` (the language badge, the no-wrap class), `slash`, `turnInto`,
`styles`, `features` (the painter), `markdown` and `html`. Two extractions in a
row now fit without new hooks.

**The technique is the point.** Highlighting an editable block by rewriting its
HTML costs the caret, the IME composition and a fight with the reconciler on
every keystroke — which is what every "syntax-highlighted contenteditable"
article spends its length managing. This plugin paints `Range`s through the
**CSS Custom Highlight API** instead, the same mechanism `cross-block-highlight.ts`
already used for the selection: the leaf keeps the text node it had, and
`e2e/code-block.spec.ts` asserts there is not one element inside it. The
trade — `::highlight()` sets colour but not `font-style` — is recorded in
`docs/research/syntax-highlighting.md` along with why not Shiki, Lezer or Prism.

**Measured.** `blocks.css` lost `.nbe-t-code`; `keymap.ts`, `slash.ts`,
`block-types.ts`, `block-actions.ts`, `schema.ts`, `commands.ts`,
`@nbe/markdown` and `@nbe/static-renderer` lost every mention of code blocks
and fences. `@nbe/core` and `@nbe/dom` still declare **zero runtime
dependencies**: `lowlight` and `highlight.js` are the plugin's, and a host that
does not register it does not download them.

**Still shared with `@nbe/dom`:** `clipboard.ts` maps a pasted `<pre>` to a
code block — the same importer exception the table left behind, waiting for the
same `pasteRules` contribution point.

### R7 — make the three bindings agree on their options — **done; verified 2026-08-08**

All three now extend `EditorViewOptions` and add exactly the same three members
— `initialContent`, `onChange`, `onReady` — which is a test rather than a
convention (`test/packaging.test.ts`). The *mount* still differs per framework,
because that is the idiom and the point; the option contract does not.
Found while building the site's integration page: `@nbe/react`'s `BlockEditor`
*spreads* `EditorViewOptions` as props, `@nbe/vue`'s nests them under an
`options` prop, and `@nbe/svelte`'s action takes them in its argument object.
Three shapes for one contract. The bindings are supposed to be
interchangeable thin mounts, and the docs cannot state one rule.
**Done when:** the same option object works in all three, and the site's three
integration snippets differ only where the framework's idiom genuinely differs.

## Track S — presentation site

**Astro**, decided rather than deferred: it renders React, Vue *and* Svelte
islands natively on the same page, which is exactly what documenting three
framework bindings requires. TanStack Start is a React application framework —
it would force the Vue and Svelte integrations to be screenshots instead of
running code. For a content site with live islands, Astro is not the
compromise, it is the better fit.

```
site/
  src/content/     MDX: concepts, guides, integrations, api  (content collections)
  src/components/  site chrome + <Demo/> islands per framework
  src/pages/       routes; api/ generated from source
```

Sections a front-end developer actually needs:
1. **Why** — the intermediate schema, file-over-app, what it is not
2. **Getting started** — vanilla in ten lines, then a framework
3. **Concepts** — blocks, ops/transactions, selection, projections
4. **Blocks** — the built-in set, and writing your own (the plugin API)
5. **Integrations** — React, Vue, Svelte, each a live island
6. **Live demo** — the full editor, embedded
7. **API reference** — generated from source, not hand-written
8. **Architecture** — the decisions, linked to `docs/`

**Reference shipped 2026-08-07.** `pnpm docs:api` runs `typedoc --json` into
a gitignored `site/.data/api.json`, rendered by our own Astro components:
`OptionsTable` (Nom / Type / Défaut / Description, the Default column shown
only when something has one), `MethodList` (signature, params, returns) and
`SymbolIndex`. Conventions and the reasoning are in `docs/DOCUMENTING.md`.

`excludeNotDocumented` is on, which is the load-bearing decision: the repo had
zero `@param`, `@defaultValue`, `@example` and `@returns` tags, so generating
everything would have produced hundreds of pages containing a name and a
source line. Coverage stops being a denominator — the reference holds 100% of
what was deliberately documented.

Two things worth knowing before extending it. `disableSources` is on because
there is no git remote yet, and without it TypeDoc emits local filesystem
paths into every entry. And the source comments are in English while the site
prose is French, so the generated reference is English — normal for a library,
but a decision rather than an accident.

**Sequencing, stated once because it matters:** the site's reference section
documents the API that Track R is changing. Writing both at full speed means
writing the reference twice and shipping a site that is wrong the day R3
lands. So S runs now for everything that does not depend on the API surface —
architecture, design system, concept and philosophy pages — and its reference
section is written after R3–R5 settle. Nothing waits; only the reference is
ordered.

## Roadmap placement

This is not a new phase. It is the prerequisite the roadmap already names as
"plugin distribution story" under Phase 5 non-goals, pulled forward because
the 14-file measurement makes it the binding constraint on the ecosystem —
and because Phase 4's vault projection will add a *fourth* projection, which
is far cheaper to add to a contribution API than to a fifth closed switch.

Order: **~~R1~~ → R2 → ~~(S scaffold)~~ → R3 → R4 → R5 → (S reference) → R6**, with
Phase 4 starting once the API is stable enough that a storage backend is a
feature plugin rather than another hardwired `attach*`.
