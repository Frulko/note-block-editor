# @nbe/blocks-code

The code block as a plugin: syntax highlighting that never touches the DOM, a
searchable language picker, `` ``` `` as a shortcut, fenced-markdown in both
directions, and real `<span>`s in the static export.

```ts
import { code } from '@nbe/blocks-code/dom'
new EditorView(el, editor, { blocks: [...builtinBlocks, code] })
```

Headless — a CLI, a server, an importer — takes the model half:

```ts
import { codeBlocks, loadLanguage } from '@nbe/blocks-code'
const plugins = new PluginRegistry().registerAll(codeBlocks)
await loadLanguage('python')                  // grammars load on demand
renderBlocksToHTML(blocks, { plugins })       // coloured <pre><code>
blocksToMarkdown(blocks, { plugins })         // ```python fences
```

## Why the colours are painted, not marked up

Highlighting an editable block by rewriting its HTML costs you the caret, the
IME composition and a fight with the DOM→model reconciler, every keystroke.
This plugin uses the **CSS Custom Highlight API** instead: the tokenizer
returns `(start, end, group)` triples, those become `Range`s, and the ranges go
into `CSS.highlights`. The leaf keeps the exact text node it had — the e2e
suite asserts there is not one element inside it — and the colours live in a
registry no editor machinery can see.

The cost, stated plainly: `::highlight()` can set colour but not `font-style`
or `font-weight`, so comments are not italic and keywords are not bold. In a
browser without the API, the code is plain and perfectly readable.

`docs/research/syntax-highlighting.md` has the full comparison — why not Shiki
(async, WASM, built to highlight once at build time), why not Lezer (the right
shape, fifteen languages), and why not Prism (no release in a year).

## What it ships

- **`lowlight` + `highlight.js`** — 190+ grammars, synchronous, and a
  structured output instead of an HTML string. Thirty languages are wired to
  lazy `import()`s, so a document with one Python block loads one grammar.
- **Nine palette groups** (highlight.js emits ~50 scopes), each a CSS variable
  on the editor, so a host theme moves the syntax colours with everything else.
- `props`: `language`, `wrap`.
- Enter adds a line, Tab indents two spaces, Shift+Tab outdents.
