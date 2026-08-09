# Syntax highlighting in an editable block — what to use, and how to paint it

Written 2026-08-09, before `@nbe/blocks-code`. The question is not "which
highlighter is prettiest" — it is **which one survives a caret**, because our
code block is a `contenteditable` leaf that a person is typing into, not a
`<pre>` on a documentation page. Almost every comparison online answers the
other question.

## 1. The constraint the comparisons miss

A static-site highlighter turns code into HTML. In an editor, replacing the
leaf's HTML on every keystroke means:

- the caret is destroyed and must be restored by offset, every keystroke;
- IME composition breaks (the composed text lives in DOM nodes we just
  replaced);
- our MutationObserver "extension defense" and the DOM→model reconciler
  (`input.ts`) both see churn they have to arbitrate;
- undo/collab see nothing wrong, but the *view* does the work twice.

Every "syntax highlighted contenteditable" article is about managing exactly
this: [CSS-Tricks](https://css-tricks.com/creating-an-editable-textarea-that-supports-syntax-highlighted-code/)
and [zserge's minimal editor](https://zserge.com/posts/js-editor/) both save
and restore the selection around a re-render, or hide a `<textarea>` behind a
styled `<pre>` — an overlay that cannot work here, because our block *is* the
editable surface.

**There is a third way, and we already ship it.** The
[CSS Custom Highlight API](https://www.bram.us/2024/02/18/custom-highlight-api-for-syntax-highlighting/)
paints ranges without touching the DOM: build `Range` objects, register them in
`CSS.highlights`, style them with `::highlight(name)`. `cross-block-highlight.ts`
already does this for the selection, `canPaintCrossBlock()` already gates on
support, and `modelPointToDom()` already converts a model offset to a DOM
position.

So: **the DOM never changes when highlighting changes.** No caret restore, no
reconciler interaction, no composition risk, nothing for the observer to see.

Its cost is real and worth stating: `::highlight()` accepts only `color`,
`background-color`, `text-decoration`, `text-shadow` and
`-webkit-text-stroke` — **no italic comments, no bold keywords**. Notion's code
block uses colour alone, so this is a trade we can make honestly.

## 2. So the tokenizer must return *positions*, not HTML

That single requirement reorders the field:

| library | maintained | output | fits a caret? |
|---|---|---|---|
| **highlight.js** (via **lowlight**) | yes, actively | hast tree → offsets by walking | **yes** — sync, no init, 190+ languages |
| Prism | **v1 has had no release in 12 months; v2 unreleased since 2022** ([roadmap](https://github.com/orgs/PrismJS/discussions/3531)) | token stream with lengths | yes, but the project is stalled |
| Shiki | yes | `codeToTokens()` with offsets | poorly — async init, WASM or a regex transpiler, themes as inline hex |
| Lezer (CodeMirror) | yes | `highlightTree()` emits `(from, to, classes)` — the exact shape we want | **best fitted**, but ~15 official languages |
| starry-night | yes | hast with positions | GitHub-grade grammars, oniguruma WASM |

Two candidates survive.

**Lezer is the technically correct answer and we are not taking it.** It is
incremental, error-tolerant by design (half-typed code is the *normal* state in
an editor, and that is where regex tokenizers flicker), and `highlightTree`
hands back ranges with no walking. But a language is a package
(`@lezer/javascript`, `@lezer/python`, …) and there are about fifteen. A code
block in a notes app has to cope with whatever someone pastes — bash, SQL, YAML,
Dockerfile, Swift, Kotlin — and "no grammar" means *no highlighting at all*.
Coverage beats tree quality for a block that is typically twenty lines.

**Shiki is the best output and the wrong shape here.** VS Code grammars and
themes, genuinely the nicest colours, and used by VitePress/Astro because they
highlight *once, at build time*. In a keystroke loop it brings an async
initialization, a WASM regex engine (or `oniguruma-to-es`, which transpiles
patterns at load), grammars measured in hundreds of KB, and colours as inline
hex that would fight our token layer instead of following it.

**Decision: `lowlight` + `highlight.js`.** lowlight is highlight.js with a
structured output instead of an HTML string — the same 190+ grammars, ESM,
synchronous, `createLowlight()` with only the languages we register, and
`highlightAuto(code, {subset})` for free language detection on paste. We walk
its hast tree once to get `(start, end, scope)` triples; from there the live
editor paints ranges, and the static HTML export emits real `<span>`s, because
an exported page has no caret to protect. One tokenizer, two renderings.

## 3. Why a dependency at all

Rung 5 of the ladder, deliberately. A highlighter is a *maintained corpus*
problem, not a code problem: writing our own regex tokenizer for ten languages
looks like an afternoon and rots on the first template literal, heredoc or JSX
fragment. This is the case a dependency exists for.

And it is a dependency **the plugin owns** — `@nbe/core` and `@nbe/dom` stay at
zero. That is the payoff from the table extraction: a block can now bring its
own library, its own CSS and its own interaction without any of it reaching the
editor everyone else ships.

## 4. What "a real code block" means, beyond colours

Measured against Notion, Linear and Obsidian, the parts that matter:

- a **language picker** that is searchable, because a fixed dropdown of ten is
  useless and a list of 190 is unusable without a filter;
- **language detection on paste** (`highlightAuto` restricted to a subset), so
  pasting a stack trace or a snippet lands correct without a menu;
- **Tab indents** rather than moving focus, Shift+Tab outdents, Enter inserts a
  newline instead of splitting the block;
- **copy**, because that is what a code block is *for*;
- **wrap / no-wrap**, because long lines are a real choice and both are wrong
  half the time;
- the markdown projection round-tripping ` ```lang ` fences, which the language
  picker must therefore agree with.

Line numbers and diff gutters are deliberately out: Notion has neither, and
they interact badly with a caret.
