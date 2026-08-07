# Documenting the public API

The API reference is **generated from the source**, so what the source says is
what a developer reads. This is the convention that makes that survivable.

Rationale and the survey it comes from: `docs/research/api-documentation.md`.

---

## The rule that matters most

**Nothing appears in the reference unless it carries a doc comment.**

`excludeNotDocumented` is on. That is deliberate, and it is the whole defence
against the failure mode this project would otherwise walk into: at the time
this convention was written the repository had 556 extractable symbols, 135
with any comment, and **zero** `@param`, `@defaultValue`, `@example` or
`@returns` tags. Generating from that produces hundreds of pages whose entire
content is a name and a source line, and a reader learns after two clicks that
the reference is worthless.

So coverage stops being a denominator. The reference contains 100% of what
someone deliberately documented, rather than 24% of what happens to be
exported. Undocumented does not mean broken — it means not yet part of the
promised surface.

## What to write

### The first sentence is the whole entry in a table

It lands in the Description cell of every index and options table, so it must
stand alone. One sentence, imperative, no "This function…".

```ts
/** Insert a plain-text run at the caret, replacing any selected range first. */
```

Not: *"This function is used to insert text into the editor."*

### `@param` — we had zero of these

Without them a generator renders parameters as bare headings with no text.
Name the meaning, not the type; TypeScript already has the type.

```ts
/**
 * Move a row to a new index within its table.
 *
 * @param tableId - The table to act on.
 * @param from - Current row index, zero-based.
 * @param to - Destination index, interpreted after the row is lifted out.
 */
```

### `@defaultValue` — the Default column is empty without it

TSDoc spells it `@defaultValue`; that is the spelling we use.

```ts
/**
 * Gap between the anchor and the floating element, in pixels.
 * @defaultValue 6
 */
offset?: number;
```

### `@remarks` — the most-skipped, most-missed tag

It separates the one-line summary from the long explanation. Without it,
everything lands in the summary and table cells become paragraphs.

```ts
/**
 * Where a contribution sits relative to others of its kind.
 *
 * @remarks
 * Named categories rather than numbers, because a module in isolation cannot
 * know what numbers other modules chose. Lexical shipped five numeric buckets
 * and had to add negative constants that bit-mask back into them.
 */
```

### `@example` — inline, per symbol

Inline examples are what make a reference readable rather than merely correct.

````ts
/**
 * Tag a contribution with a precedence.
 *
 * @example
 * ```ts
 * keys: { Enter: at('high', handleEnter) }
 * ```
 */
````

### `@internal` — the only thing between our barrels and Vue Router's problem

Vue Router's public reference documents `_PathParserOptions`, `_Awaitable`,
and generics named `rvlm`. That happens because `export *` re-exports helper
types and a generator cannot tell a concept from a compiler artifact. Mark
them.

### `@deprecated` — always with the migration target

A bare `@deprecated` is hostile. Say what to use instead.

### `@category` — so the docs mirror the product, not the compiler

Without it TypeDoc groups by AST kind: `Functions`, `Interfaces`,
`Type Aliases`. Nobody thinks *"I need a type alias"*. Use the concepts this
project actually has.

Categories in use: `Blocks`, `Operations`, `Selection`, `Projections`,
`Plugins`, `UI`, `Database`.

## What not to write

- **Types in comments.** `@param {string} name` — TypeScript has it, TypeDoc
  ignores it, and the two drift.
- **`@returns` restating the type.** Write it when the return needs
  explaining, not to say `boolean`.
- **Prose that belongs in a guide.** The reference *describes*; guides
  *explain*. When a symbol needs a concept explained, `@see` the guide and
  keep the entry short. That seam is what stops the two rotting apart.

## On-screen strings

Nothing the editor displays may be a literal in a source file. Everything goes
through `EditorLabels`, which a host overrides in whole or in part.

This is enforced, not requested: `packages/dom/test/i18n.test.ts` walks the
editor's sources and fails on any accented literal in a module that renders
something. A dictionary nothing consults is dead code, and a codebase that
keeps adding hardcoded strings undoes the work one commit at a time — the
tripwire is what makes the dictionary hold.

Two things are deliberately outside it: emoji search synonyms, which are a
different kind of localization with a different data shape, and text
direction, which has not been exercised and would be dishonest to claim.

## The pipeline

```
pnpm docs:api      # typedoc --json → site/.data/api.json (gitignored)
```

Three rules, borrowed from teams who got this wrong first:

1. **Generated data is never committed.** Regenerate in CI; the site's loader
   warns and returns empty when the file is absent, so unrelated site work
   does not depend on it.
2. **Generation is deterministic.** No timestamps in the output, or every
   build produces a diff.
3. **The generator produces fragments; humans compose pages.** Swiper's API
   page hand-imports about seventy generated components. Astro's config
   reference hardcodes its own header and intro. Nobody at that quality level
   renders a generator's output straight to a page — and the page the request
   named as the bar, TanStack Query's `QueryClient`, is hand-written markdown.
