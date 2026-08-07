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

### R2 — finish the UI primitive layer
`ui/` has floating, menu, tooltip, hover, drag, ghost, upload, icon picker,
action button. It is missing the form layer, which is why `database.ts` is 957
lines: it hand-rolls `inlineInput`, bare `<select>`s, its own validation
status, and lays out property panels by hand.

Add: `field` (label + control + hint + error), `input`, `select`, `checkbox`,
`segmented`; extract a real `popover` out of `menu` (today every non-list
overlay fakes being a menu item via `{kind:'custom', el}`).
**Done when:** `database.ts` and `icon-picker.ts` are *smaller*, not merely
different — this step must delete more than it adds.

### R3 — per-editor block registry
`BlockView { render, actions, keys, slash, turnInto }`, held by the view
instance rather than in module-global `Map`s. Replaces `render.ts`'s switch,
`block-actions.ts`/`block-toolbar.ts`'s import-time side effects, `slash.ts`'s
`ITEMS`, and `block-types.ts`'s `TURN_INTO`.
Built-ins move into `blocks/<type>.ts` modules and are re-exported as
`starterBlocks`, so the default experience is unchanged and removable.
**Done when:** two editors on one page can have different block sets.

### R4 — features as an array
`view.ts`'s 12 hardwired `attach*(view)` calls become
`features: [slashMenu, dragAndDrop, …]` with today's list as the default. The
signature already matches; this is mostly moving a line. No priority system,
no contention story — deliberately, until something forces one.
**Done when:** an editor built without the slash menu does not ship it.

### R5 — projections as contributions
`BlockProjection { toMarkdown, fromMarkdown, toStaticHtml, fromClipboardHtml }`
so a block can reach markdown and the static renderer without those packages
importing `dom`. Unknown types keep their existing honest fallback
(`<!-- nbe:type -->`), never silence.
**Done when:** a block type unknown to the projections round-trips lossily and
*visibly*, and a plugin can make it lossless without touching those packages.

### R6 — extract one real plugin package
`@nbe/blocks-callout` with the §9 subpath split: schema entry (deps `core`),
`/dom` entry (deps `dom`), `/markdown` entry (deps `markdown`). One package,
to prove the seams are real. Not a family of them.
**Done when:** removing it from the array removes it from the bundle.

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
