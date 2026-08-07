# API reference documentation — what the good ones do, and what our code needs first

Research note, 2026-08-07. Sources fetched and, for the tooling section, **run
against this repository** rather than assumed.

---

## 1. The measurement that changes the plan

TypeDoc was run on this repo as it stands (`entryPointStrategy: 'resolve'`,
zero config changes, 0 errors, 860 KB of JSON):

| measured over | count | documented |
|---|---|---|
| every reflection TypeDoc extracts (incl. properties, methods, params) | 556 | **135 — 24%** |
| top-level exports only (`export const/function/class/interface/type`) | 269 | **124 — 46%** |

The two denominators tell the same story from opposite ends: the *concepts*
are about half documented, and the *members* of those concepts almost not at
all. A reference renders members.

Block tags, counted independently across every package:

| tag | occurrences |
|---|---|
| `@param` | **0** |
| `@defaultValue` / `@default` | **0** |
| `@example` | **0** |
| `@returns` | **0** |
| `@remarks`, `@deprecated`, `@internal`, `@category` | **0** |

Not "few". None. Every doc comment in this repository is a prose paragraph and
nothing else — which is a real strength for explaining *why* a thing exists,
and produces nothing at all for a Type / Default / Description table.

Generating a reference today would produce hundreds of pages whose entire
content is a name and a source line. That is the primary way generated
API docs end up worse than no API docs: a reader learns after two clicks that
the reference is empty and never comes back.

Run on our code, `typedoc-plugin-markdown` produced 195 files for two packages,
with four lines of breadcrumb per page, parameters rendered as bare headings
with no text (because we have no `@param`), and — because the git remote did
not resolve — a leaked local filesystem path in every "Defined in:" line.

**So the first step is not tooling. It is the input.**

## 2. The finding that reframes the target

The two sites named as the quality bar are built in opposite ways, and it
matters which is which:

- **Swiper's API page is generated** — `typedoc --json`, then hand-written
  walkers, then one React component per table, then a hand-authored `.mdx`
  page that imports about seventy of them.
- **TanStack Query's `QueryClient` page is hand-written markdown.** TanStack
  does run TypeDoc, but only for the framework adapters, and those generated
  pages look like this: `## Param`, `## Param` (twice, unlabelled), `## See`,
  `## Call Signature`, `Defined in: …`.

So the reference the request pointed at as the standard is the one a human
typed. That is not an argument against generation — it is an argument that
**the page composition is always hand-authored, and the generator produces
fragments**. Swiper hand-imports seventy generated components; Astro's docgen
hardcodes the page header and intro prose. Nobody at this quality level renders
a generator's output straight to a page.

## 3. What the good ones actually do

**Column sets differ per entity kind.** Swiper: options get `Name | Type |
Default | Description`; events get `Name | Arguments | Description`; methods
get `Name | Type | Description`. You never see an empty "Default" column on an
event. This is the most directly copyable idea in the survey.

**Type, required and default in one TypeScript-shaped string.** TanStack writes
`` `queryCache?: QueryCache` `` — the `?` *is* the optionality marker, because
TS syntax already encodes it. A separate "Required" column is redundant. Use a
Default column only when you actually have defaults to put in it: Swiper does,
TanStack doesn't, and each chose accordingly.

**Anchors must be namespaced and path-aware.** Swiper generates
`#param-navigation-nextEl`; Stripe does full dot-paths to arbitrary depth.
Without this, the second `enabled` option on a page collides with the first.

**Reference describes; guides explain.** TanStack's reference states
`filters?: QueryFilters` and links the *words* to a concept guide. The
reference never explains, the guide never enumerates. That seam is what keeps
both coherent.

**Heading-per-option beats a table when the prose matters.** Floating UI uses
`###` per option precisely because warnings and caveats do not fit in a table
cell. Our schema/props surface is table-shaped; our command surface is not.

## 4. The convention that makes generation survivable

Astro's config reference — a page that is explicitly "generated from Astro's
source" and still reads well — works because of three deliberate choices:

1. **`@docs` is opt-in.** Nothing is documented unless a human tagged it.
   Coverage stops being a denominator: 100% of what is marked, rather than 24%
   of what exists.
2. **The generator `throw`s** on a malformed block — missing `@name`, missing
   `@type`/`@typeraw`. A convention nobody checks is a convention nobody
   follows.
3. **`@typeraw` is a human override** for when the inferred type is technically
   correct and useless. Every good reference has this escape hatch; purely
   generated ones don't.

Tags that actually earn their place, in rough order of leverage for us:

| tag | why |
|---|---|
| the untagged first sentence | the only thing that lands in a Description cell — one sentence, imperative, never "This function…" |
| `@param name desc` | we have **zero**; without it every parameter renders as a bare heading |
| `@defaultValue` | fills the Default column; without it the column is empty and the table is pointless |
| `@example` | inline per-option examples are what make Swiper's tables readable |
| `@remarks` | separates the one-line summary from the long explanation — the tag most often skipped and most missed, because without it everything lands in the summary and table cells become paragraphs |
| `@deprecated <what to use instead>` | a bare `@deprecated` is hostile |
| `@internal` | the only thing between our `export *` barrels and Vue Router's problem (see below) |
| `@category` | otherwise TypeDoc groups by AST kind — nobody thinks "I need a type alias" |

Do **not** write types in comments (`@param {Type}`): TypeScript has them and
TypeDoc ignores them.

## 5. The cautionary example, reproduced on our code

Vue Router renders `typedoc-plugin-markdown` end to end, and its public API
reference documents `_PathParserOptions`, `_Awaitable`, and generics named
`rvlm`, `rl`, `r`. Pages carry `#### Inherited from →
EXPERIMENTAL_RouterOptions_Base.history` — implementation detail presented as
documentation. Boilerplate is 40–45% of the page.

We would get the same, for the same reason: `export * from './types'` barrels
re-export helper types, and the generator cannot tell a concept from a
compiler artifact. `@internal` plus `excludeInternal`, or a curated `index.ts`
that is not `export *`, is the fix.

## 6. Recommendation

**Step 0 — fix the input before touching tooling.** Adopt an opt-in tag, and
document deliberately. Generation is a multiplier on comment quality;
multiplying by 0.24 gives an artifact worse than the seven hand-written pages
the site already has.

**Step 1 — `typedoc --json` into a gitignored file, rendered by our own Astro
components.** This is both the right answer and the lazy one here:

- The site is plain Astro + MDX, **not Starlight**, so `starlight-typedoc`
  would mean adopting Starlight and migrating every hand-written page — a
  bigger diff than writing a renderer.
- Our API has two shapes (a schema/options surface and a command surface), and
  Swiper-grade quality means different column sets per kind. Every
  markdown-emitting tool gives exactly one shape.
- `typedoc --json` already works on this repo with no config changes; a
  `PropsTable` / `MethodList` / `TypeSig` component trio is a few hundred
  lines.

Two rules borrowed from Effect, who wrote a spec for exactly this before
building it: **generation must be deterministic** (no timestamps, or every
build diffs), and **generated data is never committed** — regenerate in CI,
gitignore it, and have the loader warn-and-return-empty when absent so
unrelated site work does not depend on it.

Non-negotiable settings, from the empirical run:

```js
entryPointStrategy: 'resolve',   // 'packages' fails on this repo today: 57 errors
excludeInternal: true, excludePrivate: true, excludeNotDocumented: true,
gitRevision: 'main',             // else it ships local filesystem paths
plugin: ['typedoc-plugin-missing-exports'],
```

plus `/** @module @nbe/core */` atop each `index.ts`, or module URLs become
`/api/core/src/...`.

**Later — `api-extractor` for its `.api.md` review report, once the packages
have a build.** Its markdown documenter is the worst option surveyed, by its
own authors' description. But committing `etc/core.api.md` makes every public
API change a reviewable diff, and CI fails when the signature moves. For a
seven-package library heading toward 1.0 that is worth more than the docs
themselves — and it is the only real answer to prose drift, because it forces
a human to look at every signature change while the guide is still open.

**Versioning: do nothing.** We are at `0.0.1`. Do not build a version-switching
abstraction before there are two versions.

## 7. Drift, and the one thing that actually fixes examples

Only one mechanism stops code examples rotting: **typecheck them**.
`@effect/docgen` compiles every `@example` block against a separate compiler
config. Astro at least colocates examples with the type so a change is visible
in the same diff. Swiper's `@example` blocks are unchecked — and Swiper's docs
carry stale snippets.

Two more worth adopting cheaply:

- **Nightly regeneration as a pull request**, not a push (Astro's `ci/docgen`
  branch, scoped with `add-paths`). Upstream drift shows up as a reviewable
  diff on a predictable cadence.
- **Link and anchor checking in CI.** When a generated anchor disappears, the
  guide that linked to it should fail the build; otherwise the reference/guide
  seam rots invisibly.
