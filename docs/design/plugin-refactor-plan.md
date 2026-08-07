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

### R7 — make the three bindings agree on their options
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
