# Block-Editor Landscape: Gutenberg, Editor.js, BlockNote, TipTap

Research date: 2026-08-06. Versions verified against the npm registry on that date: `@wordpress/blocks` 15.25.0 (2026-07-29), `@editorjs/editorjs` 2.31.6 (2026-04-07), `@blocknote/core` 0.52.1 (2026-07-20), `@tiptap/core` 3.29.2 (2026-07-28).

## TL;DR

- **Gutenberg** serializes blocks to HTML with JSON-in-HTML-comment delimiters; the payoff is graceful degradation and renderability without the tool, the cost is a brittle "markup is the source of truth" model where any change to a block's `save()` output invalidates existing content and requires a manually maintained `deprecated[]` array of every historical markup version.
- **Gutenberg's block.json** is the most mature *declarative* block registration design of the four: one JSON manifest shared by PHP and JS, driving asset loading, REST discovery, attribute sourcing, and editor tooling — worth copying in spirit.
- **Editor.js** has the cleanest pitch (pure JSON out, dead-simple Tool class API) but the shallowest model: no nested blocks by design, inline formatting stored as raw HTML strings inside JSON, columns only via a hack that instantiates whole child editors inside a block; maintenance is part-time and v3 has been "in development" since 2023 while 2.x gets a patch release every month or two.
- **BlockNote** is the closest existing thing to "Notion editor as a library": ProseMirror/TipTap underneath, a typed `Block {id, type, props, content, children}` JSON model with real nesting, ships slash menu / side drag handle / formatting toolbar by default; still 0.x, React-first, and its columns/export/AI features are GPL-3.0-or-commercial "XL" packages.
- **TipTap** is the strongest *headless framework*: MIT core wrapping ProseMirror with ~100 extensions, framework bindings for React/Vue/Svelte/vanilla, v3 (stable July 2025) added SSR, a static renderer, and MarkViews — but it has no first-class block/document concept (blocks are a UX pattern you build), and collab/comments/versioning are paid cloud products.
- Serialization verdict from prior art: an **ID-addressed JSON tree as canonical**, with Markdown/HTML as *projections*, is what everyone who fought Gutenberg's HTML-comment format wishes they had; Gutenberg's own docs concede the comment format exists for WordPress-specific backward-compatibility constraints we don't have.
- Nesting must be **in the core data model from day one** (children array or content expressions); Editor.js proves it cannot be retrofitted, and its column plugin (nested editor instances, broken Enter/Tab/copy-paste) is the cautionary tale.
- Accessibility is an architecture decision, not a polish pass: the $31k Tenon audit of Gutenberg failed all 30 applicable WCAG 2.1 success criteria at launch, and the WP a11y team had told people not to use it — after the code was already shipped.
- Business-model signal: every serious player monetizes the same layer — collaboration/sync, comments, AI, export (TipTap cloud tiers $49–$999/mo; BlockNote XL dual-license) — which means the open-source core must be genuinely complete *without* that layer or the community forks away.

## Findings

### 1. Gutenberg (WordPress block editor)

#### 1.1 Block registration: block.json + edit/save

Since WordPress 5.8 the canonical way to register a block is a `block.json` metadata file, used by both PHP (`register_block_type`) and JS (`registerBlockType`) ([Block metadata — Block Editor Handbook](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-metadata/)). The handbook gives explicit rationale for a declarative manifest:

- **Code sharing across languages** — "code sharing between JavaScript, PHP, and other languages when processing block types stored as JSON."
- **Performance** — assets listed in `style`/`script` "will only be enqueued when the block is present on the page."
- **Discoverability** — only server-registered blocks appear in the block-types REST endpoint; the plugin directory extracts block metadata from the file.
- **Tooling** — a published JSON schema gives editors "tooltips, autocomplete, and schema validation."

Key fields: `apiVersion` (currently 3), `name` (`namespace/block-name`), `attributes`, `supports` (opt-in editor features: alignment, color, spacing…), `editorScript`/`script`/`viewScript`, `render` (PHP file for dynamic/server-rendered blocks, receiving `$attributes`, `$content`, `$block`), `variations` (one block, multiple presets), and `usesContext`/`providesContext` (ancestor→descendant data flow, e.g. a query block providing `postId` to inner blocks).

The behavior lives in JS: `edit` (React component shown in the editor) and `save` (pure function producing the serialized HTML). Attributes are either stored in the comment delimiter JSON or **sourced from the saved HTML itself** — e.g. `"source": "html", "selector": ".message"` re-extracts content from the DOM on parse ([Block metadata](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-metadata/)). This "attributes sourced from markup" mechanism is clever and is also the root of Gutenberg's biggest fragility (see 1.3).

#### 1.2 Serialization to HTML comments: why, and at what cost

Post content is stored as HTML in `post_content`, with blocks delimited by HTML comments carrying a JSON attribute payload:

```html
<!-- wp:image {"id":123,"sizeSlug":"large"} -->
<figure class="wp-image"><img src="..." /></figure>
<!-- /wp:image -->
```

The official rationale ([Key concepts — Block Editor Handbook](https://developer.wordpress.org/block-editor/explanations/architecture/key-concepts/), [Data flow](https://developer.wordpress.org/block-editor/explanations/architecture/data-flow/)): stay backward compatible with a 15-year corpus of HTML posts and the thousands of plugins/themes reading `post_content`; keep content human-readable and renderable even if WordPress (or the block's plugin) disappears; comments survive HTML processing because "the design doesn't depend on having fully-valid HTML" and delimiters can be matched with fast regexes (the parser is a small PEG; there are multiple official parser packages, including PHP and JS — [@wordpress/block-serialization-default-parser](https://developer.wordpress.org/block-editor/packages/packages-block-serialization-default-parser/)). The early design debate is public in [Issue #391: Block parsing and serialization](https://github.com/WordPress/gutenberg/issues/391), and the original framing in [Gutenberg posts aren't HTML](https://fluffyandflakey.blog/2017/09/04/gutenberg-posts-arent-html/): the post is really a serialized block tree that merely *looks like* HTML.

The criticism is equally well documented. Greg Schoppe's [What's so bad about HTML Comments as structure?](https://gschoppe.com/wordpress/comments-arent-structure/) demonstrates concrete failure modes:

- Round-tripping a Gutenberg post through TinyMCE (or any third-party editor that doesn't know the grammar) corrupts it — "literally no changes were made to the post. It was only opened and saved" and the structure broke. The claimed backward compatibility is one-directional.
- Comments are invisible in text-mode editing, so users mangle block boundaries without knowing (his demo produces "a second, empty block" from a trivial edit).
- "Blocks are structured data, not HTML" — conflating structure and presentation blocks alternate renderings (his example: same document rendering as CSS columns for browsers and table markup for email).
- JSON "is supported out of the box in pretty much every modern programming language"; the comment grammar requires a custom parser in every consumer.

Practitioners who need structured access to Gutenberg content end up re-parsing it into JSON anyway ([Parsing WordPress Block Data](https://dev.to/shelob9/parsing-wordpress-block-data-29am), [Access all block attributes structurally](https://fluffyandflakey.blog/2022/12/06/access-all-block-attributes-structurally-with-the-gutenberg-block-editor/)), and a cottage industry exists for bypassing the format entirely and saving to post meta ([Beyond HTML Comments — GiveWP](https://givewp.com/beyond-html-comments-how-to-save-your-data-any-way-you-like-with-gutenberg/)).

**The honest read**: HTML-comment serialization was the right call *for WordPress's specific constraint* (an existing HTML column read by an entire ecosystem) and is the wrong call for a greenfield tool. Notably, the *dual* nature — human-readable rendering plus machine-parseable structure — is a genuinely good goal; the mistake is making the rendered form the *only* persisted, canonical form.

#### 1.3 Validation, invalidation, deprecations, migrations

Because the saved HTML is canonical, Gutenberg *validates* every block on load: it re-runs the block's current `save()` against the parsed attributes and compares with what's in the database. Mismatch ⇒ the dreaded **"This block contains unexpected or invalid content"** dialog, and the block won't render its controls until manually "recovered". A developer quoted in [WP Tavern: What Happens When Block Markup Changes?](https://wptavern.com/ask-the-bartender-what-happens-when-block-markup-changes) describes the operational nightmare: "all of the blocks will enter a state of invalidation… The CMS editor would have to go into thousands of pages and manually click the button which allows the block to be recovered." The same article lands the architectural diagnosis: "HTML markup is the overall source of truth, when it should be the attributes and/or state."

The escape hatch is the [Deprecation API](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-deprecation/): a `deprecated: []` array where each entry is a frozen snapshot of a previous version's `attributes`, `supports`, and `save`, plus optional `migrate(attributes, innerBlocks)` (returns new attributes or `[attributes, innerBlocks]`) and `isEligible` (force-migrate even structurally-valid old blocks). Mechanics worth knowing:

- Deprecations are **not a chain**: on validation failure the editor tries each deprecation in order (docs recommend reverse-chronological), and the first whose `save` reproduces the stored markup wins; its attributes are migrated and re-saved with the *current* `save`. "It is important to note that if a deprecation's `save` method does not produce a valid block then it is skipped completely, including its `migrate` method."
- Nothing is inherited: "Attributes, supports, and save are not automatically inherited from the current version" — each deprecation must be a complete copy.
- Deprecations rot: "if a deprecation's `save` method imports additional functions from other files, changes to those files may accidentally change the behavior of the deprecation" — you must effectively vendor frozen copies of helpers into each deprecation.
- Migration only runs when content passes through the editor; published posts that are never re-opened keep old markup forever, so the front-end must keep rendering every historical version too.

Core blocks accumulate long deprecation arrays (the embed and gallery blocks have many versions). This is the single most complained-about developer-experience area of Gutenberg block development, and it is a *direct consequence* of the serialization choice.

#### 1.4 Nesting and columns

Nesting is first-class via **InnerBlocks**: "a block can be nested within another block", parent/child relationships, with the Columns block as the canonical example ([Key concepts](https://developer.wordpress.org/block-editor/explanations/architecture/key-concepts/)). Layout is modeled as blocks-in-blocks: `core/columns` contains N `core/column` children, each containing arbitrary blocks. Parents can restrict children (`allowedBlocks`), children can restrict ancestors (`parent`/`ancestor` in block.json), templates can pre-seed inner structure, and `providesContext`/`usesContext` passes data down the tree. Serialization nests the comment delimiters recursively — parsing must be a proper recursive parser, not a flat scan. This "columns are just a block with children" design is proven and is what BlockNote later copied.

#### 1.5 What the WordPress community learned the hard way

**Launch postmortem.** WordPress 5.0 shipped Gutenberg in December 2018, timed days before WordCamp US, over loud objections. [Smashing Magazine's postmortem](https://www.smashingmagazine.com/2019/10/postmortem-gutenberg-launch-product/) and contemporaneous coverage catalog the damage: shipped while "not ready", near-absent developer documentation, serious performance issues, and a fractured community — the Classic Editor plugin accumulated millions of installs as an opt-out ([Yoast: On Gutenberg and WordPress 5.0](https://yoast.com/on-gutenberg-and-wordpress-5-0/), [CMS Critic: Gutenberg, 2 Years Later](https://cmscritic.com/gutenberg-2-years-later-is-wordpress-better-off)). Retrospectives agree the product eventually became good, but the trust damage persisted for years.

**Accessibility audit.** In October 2018 the WordPress Accessibility Team stated they could not recommend Gutenberg to anyone relying on assistive technology; the team's lead resigned. WPCampus crowdfunded ($10,264 from ~100 community members, remainder covered by Automattic/Mullenweg) a $31,200 independent audit by Tenon LLC — a 329-page technical report plus user testing with people with disabilities ([WPCampus audit results](https://wpcampus.org/blog/2019/05/gutenberg-audit-results/), [WP Tavern coverage](https://wptavern.com/wpcampus-gutenberg-accessibility-audit-finds-significant-and-pervasive-accessibility-problems)). Findings: the *output markup* was "clean, semantically correct and accessible", but the *editing experience* had "significant and pervasive accessibility problems" — Gutenberg failed **all 30 applicable WCAG 2.1 success criteria** — and Tenon filed 90 GitHub issues. The structural lesson: a block editor's chrome (toolbars, drag handles, floating menus, modals, focus management across nested editable regions) is where accessibility lives or dies, and it cannot be bolted on after the interaction model is fixed.

### 2. Editor.js

#### 2.1 Model and pitch

Editor.js (CodeX team, Apache-2.0) is "a free, block-style editor with universal JSON output" ([editorjs.io](https://editorjs.io/)). Output is a single object:

```json
{
  "time": 1765710475758,
  "version": "2.31.6",
  "blocks": [
    { "id": "mhTl6ghSkV", "type": "paragraph", "data": { "text": "Hey. Meet the <b>new</b> Editor..." } },
    { "type": "header", "data": { "text": "Key features", "level": 3 } }
  ]
}
```

Each block is `{id, type, data, tunes?}` where `data` is whatever the tool's `save()` returned. The pitch — same JSON renders to web, native mobile, AMP/Instant Articles, audio — is exactly our "schema between editing and rendering" idea, and Editor.js deserves credit for articulating it early (2016–2018 era, as CodeX Editor).

#### 2.2 Block Tool API

A tool is a plain class ([Creating a Block Tool](https://editorjs.io/creating-a-block-tool/)):

- `constructor({data, api, config, block})` — saved data, editor API facade, user config, block accessor.
- `render(): HTMLElement` — return a DOM element; the editor mounts it. No virtual DOM, no framework.
- `save(blockContent: HTMLElement): object` — *scrape the DOM* back into JSON. This is the crucial design difference: state lives in the DOM between renders, and `save()` is an extraction step, not a read of a model.
- `validate(savedData): boolean` — optional gate before persistence.
- `static get toolbox()` — `{title, icon}` for the insert menu; `static get sanitize()` — per-field HTML allow-list; `static get pasteConfig()` — tag/pattern substitutions for paste handling; `static get isReadOnlySupported()`.

The API is genuinely easy — a working custom block is ~30 lines with zero framework knowledge — which is why Editor.js remains popular for simple CMS embeds. But "easy to write a tool" was achieved by pushing all hard problems (selection across blocks, undo across blocks, inline model, nesting) out of scope.

#### 2.3 Real limitations

**Inline model shallowness.** Inside `data.text`, formatting is a raw HTML string (`"Hey. Meet the <b>new</b> Editor"`). There is no structured inline representation — no spans-with-marks, no schema for links/mentions. Consumers must parse HTML fragments anyway (undermining the "pure JSON" claim), sanitization is per-tool and ad hoc, and structured transforms (e.g., "find all links", collaborative OT/CRDT on text) have nothing to grip. Users asking for structured inline content were told it defeats the design ([Discussion #2255: Nested inline block](https://github.com/codex-team/editor.js/discussions/2255), [Issue #1162 / Discussion #1879: Nested blocks, for extracting links](https://github.com/codex-team/editor.js/issues/1162)).

**No nesting.** The block list is flat by design; there is no `children` concept in core. Years of issues and PRs requesting nested blocks ([Issue #1440: How to nested blocks?](https://github.com/codex-team/editor.js/issues/1440), [PR #1055: Fix for EditorJS nesting](https://github.com/codex-team/editor.js/pull/1055)) never changed the core model; even lists needed a special `@editorjs/nested-list` tool that implements its own internal tree.

**Columns as a symptom.** The community columns plugin [calumk/editorjs-columns](https://github.com/calumk/editorjs-columns) works by instantiating *complete child Editor.js instances* inside a block, passing the Editor class in via config to avoid duplicate installs. Documented known issues: Enter key exits the column, Tab opens both the child and parent toolbox, copy/paste duplicates data. Separate editor instances also mean separate undo stacks and no cross-column selection. This is the definitive demonstration of why nesting can't be a plugin.

**Maintenance state (2026).** The [«Is this project dying?» discussion](https://github.com/codex-team/editor.js/discussions/2381) (2023) got a candid maintainer answer: CodeX is "a non-profit team of open-source enthusiasts" working part-time; "resources for this are currently limited, so, unfortunately, many questions remain unanswered." Version 3.0 — the rewrite meant to fix the model (real document model, collaborative editing) — was announced there and remains unshipped three years later: as of 2026-08, latest is **2.31.6** (April 2026), with 2.x receiving roughly monthly patch releases ([changelog](https://github.com/codex-team/editor.js/blob/next/docs/CHANGELOG.md)). Recent changelog entries are fixes (deep-nesting mutation handling, inline toolbar in nested instances), not model work. The org's tool plugins are in worse shape than core ([editor-js/list issues](https://github.com/editor-js/list/issues)). Treat Editor.js as being in maintenance mode with an unfunded rewrite.

### 3. BlockNote

#### 3.1 What it is

BlockNote (TypeCell OSS, `@blocknote/core` under **MPL-2.0**) is "a block-based rich-text editor for React, focused on providing a great out-of-the-box experience with minimal setup… built on top of the widely used ProseMirror and TipTap" ([blocknotejs.org/docs](https://www.blocknotejs.org/docs)). It is the closest existing implementation of our own goal: Notion-grade editing as an embeddable library. Still **0.x** (0.52.1, July 2026) with a steady release cadence.

#### 3.2 Document model

The core abstraction is a typed block tree ([Document structure](https://www.blocknotejs.org/docs/foundations/document-structure)):

```ts
type Block = {
  id: string;                                        // unique, immutable
  type: string;                                      // "paragraph" | "heading" | ...
  props: Record<string, boolean | number | string>;  // typed, defaulted attributes
  content: InlineContent[] | TableContent | undefined;
  children: Block[];                                 // real nesting
};
```

`InlineContent` is structured — `StyledText` (text + styles object), `Link` (href + styled text), and custom inline types — i.e., the marks-on-spans model Editor.js lacks, serialized as JSON rather than HTML strings. Tables get a dedicated `TableContent` shape. Multi-column layout is modeled Gutenberg-style as blocks: a `columnList` block whose children are `column` blocks — but note it ships in `@blocknote/xl-multi-column`, an XL package (see 3.5). Under the hood, this Block JSON is a *projection over the ProseMirror document*: BlockNote maintains the friendly tree API and translates to/from PM transactions, which is precisely the "intermediate schema between editing and rendering" pattern.

#### 3.3 Custom block API

[`createReactBlockSpec(blockConfig, implementation, extensions?)`](https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks) (vanilla `createBlockSpec` also exists):

- **Config**: `type` (unique name); `content: "inline" | "none"`; `propSchema` — `Record<string, {default: value, values?: allowed[]}>` restricted to boolean/number/string primitives, with type inference from defaults.
- **Implementation**: `render` (React component receiving `block`, `editor`, and `contentRef` to mark the editable region); optional `toExternalHTML` (clipboard/export rendering — rendered in a separate React root, so context providers don't reach it); optional `parse(element): props | undefined` (paste/import matching); `meta` (`selectable`, `isolating`, `defining`, `code` — ProseMirror NodeSpec passthroughs).
- Blocks are assembled into an explicit typed schema: `BlockNoteSchema.create({ blockSpecs: { alert: createAlert() } })`, giving full TypeScript inference on `editor.document`.

This is the best-designed custom-block API of the four for *typed* development: declarative like block.json, but statically typed end-to-end, and without Gutenberg's save/validate trap because the JSON model — not rendered HTML — is canonical. Its main limitation: `props` are flat primitives (no nested objects/arrays in the prop schema), pushing complex data into workarounds (JSON-stringified props or child blocks).

#### 3.4 Default UX

Ships working out of the box, "just like in Notion" ([docs](https://www.blocknotejs.org/docs)): slash (`/`) suggestion menu, side menu with drag handle and + button on hover, formatting toolbar on selection, nesting/indentation with Tab/Shift-Tab, animations, theming, and built-in Yjs-based collaboration support in the open-source core. React components for every menu are replaceable piecemeal; "advanced users can even create their own UI from scratch and use BlockNote with vanilla JavaScript instead of React." This inversion — batteries-included with headless as the escape hatch, versus TipTap's headless-with-paid-batteries — is BlockNote's core product insight and the reason it wins "time to Notion-like demo."

#### 3.5 Constraints and licensing/business model

- **React-first**: core is usable from vanilla JS, but all shipped UI is React; Vue/Svelte users are effectively on their own for chrome.
- **0.x maturity**: breaking changes between minors are routine; no 1.0 API guarantee as of Aug 2026.
- **Inherited complexity**: it is ProseMirror + TipTap + a model layer; deep customization eventually punches through to ProseMirror concepts anyway.
- **Licensing**: core packages MPL-2.0 (file-level copyleft, safe for commercial embedding); **XL packages** — `xl-multi-column`, `xl-docx-exporter`/`xl-pdf-exporter` (+ ODT), `xl-ai` — are dual-licensed "**GPL-3.0 OR PROPRIETARY**" (verified on npm), free for AGPL/GPL-compatible open source, commercial license via the Business subscription for closed source ([Pricing](https://www.blocknotejs.org/pricing), [XL commercial license](https://www.blocknotejs.org/legal/blocknote-xl-commercial-license)). Funding also includes sponsorships and paid Pro examples/support ([About](https://www.blocknotejs.org/about)).
- **Signal for us**: even the project whose whole identity is "open-source Notion editor" put *columns* behind a copyleft/commercial gate — evidence that columns are both hard and valuable, and a differentiation opportunity if our core ships them MIT.

### 4. TipTap

#### 4.1 Headless extension model over ProseMirror

TipTap (ueberdosis, MIT core) is "a headless rich-text editor framework" wrapping ProseMirror "in a modern, framework-agnostic API" ([Getting started](https://tiptap.dev/docs/editor/getting-started/overview)). Everything is an extension — nodes, marks, and functionality (history, placeholder, collaboration cursors) — composed into the editor config. ProseMirror remains fully reachable underneath (`editor.state`, plugins, schema), so the ~2010s-era ecosystem of ProseMirror plugins keeps working; TipTap's value is packaging, DX, and defaults, not a new engine. This "thin sugar over a proven kernel, escape hatch always open" architecture is the TanStack-style layering we want, applied to editors.

#### 4.2 Custom nodes (the block-authoring API)

[`Node.create()`](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node) options: `name`; `group` ("The group or space-separated groups to which this node belongs, which can be referred to in the content expressions") — typically `'block'` or `'inline'`; `content` — a ProseMirror content expression like `'block+'` or `'paragraph listItem*'` declaring allowed children (this grammar is how PM enforces valid trees at the schema level, a capability none of the non-PM editors have); `addAttributes()` with defaults and per-attribute `parseHTML`; `parseHTML()` (DOM→node rules); `renderHTML({HTMLAttributes})` returning a structure like `['div', HTMLAttributes, 0]`; `addCommands()`; `addKeyboardShortcuts()`; `addNodeView()` for interactive UI — "where you need to execute JavaScript inside your nodes… you need to learn about node views" — with framework wrappers (ReactNodeViewRenderer etc.). NodeSpec flags (`atom`, `selectable`, `draggable`, `isolating`, `defining`) pass through. Power is maximal; the cost is that authors must learn ProseMirror's schema mental model (content expressions, node vs mark, slice semantics) — the exact learning cliff BlockNote and Editor.js exist to flatten.

Documents serialize natively to ProseMirror JSON (nested `{type, attrs, content[]}` — no stable node IDs by default; ID assignment requires an extension like the paid UniqueID or a community one) or HTML. v3's [Static Renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer) renders that JSON to HTML/Markdown/React "without an editor instance… doesn't require a browser, DOM or even an editor instance", cleanly separating render-from-schema from the editor.

#### 4.3 Framework bindings and v3

Official bindings for React, Vue (2/3), Svelte, and vanilla JS, plus community Solid/Angular ([Getting started](https://tiptap.dev/docs/editor/getting-started/overview)). **Tiptap 3.0 went stable July 12, 2025** ([release notes](https://tiptap.dev/blog/release-notes/tiptap-3-0-is-stable)): SSR support, Static Renderer, MarkViews (custom rendering for inline marks), stricter TypeScript, attribute validators, `unmount()` for editor reuse, and — a strategic shift — first-party **UI Components and templates** (open source, React) so "headless" no longer means "blank screen". Notably TipTap did a YC launch for 3.0 ([Launch YC](https://www.ycombinator.com/launches/NR5-tiptap-3-0-beta-the-next-gen-open-source-editor)) — the editor-infrastructure space is VC-funded now.

#### 4.4 Paid layer as ecosystem signal

Free MIT: core, ~100 extensions, UI components. Paid ([Pricing](https://tiptap.dev/pricing), tiers ~$49 / $149 / $999 / enterprise per month, verified Aug 2026 by [third-party breakdowns](https://eddyter.com/blogs/tiptap-pricing-explained-2026)): Pro extensions and cloud services — **Collaboration** (hosted Yjs backend), **Comments**, **Version history**, **AI commands**, **document conversion** (DOCX/ODT import-export), with per-tier document counts and developer-seat limits. Two lessons: (a) the monetizable layer in this market is *multiplayer + documents-as-a-service + AI*, not the editor core; (b) features the community expects to be open (comments, versioning) being paywalled generates recurring friction and is a standing invitation for open alternatives. TipTap has no built-in columns; multi-column layouts are community extensions ([Discussion #6317](https://github.com/ueberdosis/tiptap/discussions/6317), [@tiptap-extend/columns](https://www.npmjs.com/package/@tiptap-extend/columns), [Issue #638](https://github.com/ueberdosis/tiptap/issues/638)), though their paid DOCX conversion pipeline itself models multi-column sections as `columns`/`column` nodes ([Conversion docs](https://tiptap.dev/docs/conversion/content-types/page-layout/page-structure)) — same pattern again.

### 5. Cross-cutting comparison

#### 5.1 What makes a good block-registration / custom-block API

| Dimension | Gutenberg | Editor.js | BlockNote | TipTap |
|---|---|---|---|---|
| Declaration | `block.json` manifest + JS `edit`/`save` | ES class per tool | `createBlockSpec(config, impl)` | `Node.create({...})` |
| Attribute/prop typing | JSON-schema-ish `attributes` (typed, sourced) | none — `save()` returns anything | `propSchema`, TS-inferred, flat primitives only | `addAttributes`, untyped at runtime, TS improving in v3 |
| Content model of a block | HTML produced by `save`; attrs partly re-parsed from HTML | opaque DOM; scraped on save | `content: "inline" \| "none"` + children | PM content expressions (`'block+'`) — richest constraint language |
| Child constraints | `allowedBlocks`, `parent`, `ancestor` | n/a | limited (schema-level) | full grammar in `content` |
| Editor UI of a block | React component (`edit`) | plain DOM | React component (or vanilla) with `contentRef` | NodeView (any framework) |
| Static/export rendering | `save` (or PHP `render`) | external renderer per consumer | `toExternalHTML` | `renderHTML` + Static Renderer |
| Paste/import mapping | `transforms` API | `pasteConfig` | `parse()` | `parseHTML` |
| Versioning story | `deprecated[]` (painful but exists!) | none | none formalized | none formalized (schema migrations DIY) |

Synthesis — a good block API needs, simultaneously: (1) a **declarative manifest** (Gutenberg: enables tooling, lazy loading, cross-language registries); (2) **typed props with defaults and value constraints** (BlockNote); (3) a **content grammar for children** (ProseMirror/TipTap — the only mechanism here that makes invalid trees unrepresentable); (4) **separated concerns**: edit-view, canonical data, export renderings, paste/import rules as distinct declarations (all four converge on this split); and (5) an **explicit versioning/migration story** — only Gutenberg has one at all, and only because its format forces it; a JSON-canonical editor gets to do proper versioned migrations on the data instead.

#### 5.2 Serialization format tradeoffs

- **HTML + comment delimiters (Gutenberg)**: + renders without the tool, degrades gracefully, survives naive pipelines; − markup-as-truth causes validation/deprecation misery, custom grammar in every consumer, breaks under third-party editing. Verdict: right for WordPress's legacy constraint only.
- **Flat JSON with HTML-string leaves (Editor.js)**: + trivially storable/queryable, renderer-agnostic in theory; − inline content is unstructured HTML anyway, no nesting, no per-node identity for collab/sync. Verdict: clean-looking, shallow.
- **Typed JSON tree with structured inline content + stable IDs (BlockNote; PM JSON minus default IDs)**: + canonical, diffable, migratable, mapping cleanly to CRDTs (Yjs) and to per-block DB rows (Notion's own storage model); − not human-readable at rest, requires explicit projections for interchange. Verdict: correct canonical form.
- **Markdown**: none of the four uses it as canonical, for good reason — it cannot represent typed props, columns, or custom blocks without escape hatches, and round-tripping is lossy; TipTap v3 treats Markdown as import/export (`renderMarkdown`/`parseMarkdown` on the roadmap per the release notes), Gutenberg as a transform. Verdict: projection, not source of truth. For our "readable without the tool" requirement, that projection must be a *first-class, continuously-exercised* export (files on disk), with the lossless JSON alongside — e.g. Markdown body + fenced/frontmatter attribute payloads for non-Markdown-native blocks, which is essentially Gutenberg's dual-format idea done on Markdown with the JSON tree remaining canonical.

#### 5.3 Nesting and columns across the four

| | Nesting in core model | Columns |
|---|---|---|
| Gutenberg | Yes — InnerBlocks, recursive comment delimiters | Core `columns`→`column` blocks |
| Editor.js | No — flat by design, refused for years | Community plugin embedding whole child editors; broken keyboard/copy semantics |
| BlockNote | Yes — `children: Block[]` on every block | `columnList`→`column` blocks, but in GPL/commercial XL package |
| TipTap | Yes — PM tree + content expressions | No official extension; community packages; their DOCX pipeline uses `columns`/`column` nodes |

Convergent evolution: everyone who has columns models them as **a container block whose children are column blocks**, not as a property/layout attribute — because it reuses selection, drag, undo, serialization, and constraint machinery for free. Editor.js is the counterexample proving the rule.

## Pitfalls

1. **Don't make rendered output the canonical store.** Gutenberg's markup-as-source-of-truth yields block invalidation, the deprecations treadmill, and third-party-editing corruption ([WP Tavern](https://wptavern.com/ask-the-bartender-what-happens-when-block-markup-changes), [Schoppe](https://gschoppe.com/wordpress/comments-arent-structure/)). Canonical = structured data; everything renderable = projection.
2. **Don't ship a flat block list assuming nesting can come later.** Editor.js never recovered from this; nesting requests span 2019–2026 and the columns plugin's child-editor hack breaks Enter/Tab/undo/copy-paste ([editorjs-columns](https://github.com/calumk/editorjs-columns)).
3. **Don't store inline formatting as HTML strings inside JSON.** It forfeits the entire value of structured content (search, transforms, CRDT merging, sanitization) while still requiring an HTML parser — worst of both worlds (Editor.js).
4. **Don't ship without a block versioning/migration design.** Gutenberg's deprecations are painful but their *existence* is the lesson: block definitions WILL change; decide on day one how old documents upgrade (schema `version` field per block type + pure migration functions on the JSON, run at load — cheaper and safer than Gutenberg's save-replay because JSON, not markup, is compared). Remember Gutenberg's caveat that migrations sharing live helper code rot silently.
5. **Don't treat accessibility as polish.** Gutenberg failed all 30 applicable WCAG 2.1 criteria in a $31k audit *after* shipping to ~33% of the web, having ignored its own a11y team ([WPCampus](https://wpcampus.org/blog/2019/05/gutenberg-audit-results/)). Editor chrome — floating toolbars, drag handles, slash menus, nested focus — is the hard part; test with screen readers from the first prototype.
6. **Don't ship the platform before the docs.** The 5.0 launch postmortem: undocumented APIs + forced migration = Classic Editor plugin as a mass opt-out and years of community distrust ([Smashing](https://www.smashingmagazine.com/2019/10/postmortem-gutenberg-launch-product/)).
7. **Don't rebuild the contenteditable kernel.** Every successful newer entrant (TipTap, BlockNote) builds on ProseMirror; the failure mode of bespoke engines is Editor.js: DOM-scraping save, no cross-block selection model, unfunded rewrite. If we do write our own core, ProseMirror's concepts (schema with content expressions, positions, transactions/steps) are the proven design to steal; ProseMirror-the-library is the proven shortcut.
8. **Don't paywall the features your community considers table stakes** (comments, versioning, columns) — TipTap's and BlockNote's gates are recurring friction sources and competitor openings; conversely, DO note that collab *hosting* and AI are accepted paid layers.
9. **Don't rely on "headless" as an excuse for no UX.** TipTap added official UI components in v3 and BlockNote's whole existence is the market saying default UX matters; plan headless core + polished default chrome from the start.
10. **Don't ignore the maintenance economics.** Editor.js (volunteer, part-time) stagnated; TipTap (VC), BlockNote (dual-license), Gutenberg (Automattic) all have funding. An open-source editor is a decade-long commitment; pick a sustainability story early.

## Recommendations for our editor

1. **Canonical format: a typed JSON block tree** — `{id, type, props, content, children}` per block (BlockNote's shape), with structured inline content (spans + marks, discriminated unions for links/mentions) and **stable ULIDs on every block**; IDs are what make drag-drop, per-block comments, CRDT sync, and per-block DB rows (SQLite) tractable.
2. **Registration API: declarative manifest + typed spec.** Combine block.json's spirit (a serializable descriptor: name, props schema with defaults/enums, allowed children grammar, keywords for slash menu) with BlockNote's TS inference. Support nested prop values (learn from BlockNote's flat-primitives limitation). Keep the descriptor JSON-serializable so the future Swift editor can consume the same block registry.
3. **Give every block type a `version: number` and pure `migrate` functions** on JSON, run at document load, in the schema layer — Gutenberg's problem solved without Gutenberg's mechanism.
4. **Constrain children with a content grammar** (ProseMirror-style content expressions or a simplified allow-list + min/max), enforced by the schema layer, so columns/nesting invariants live in data, not UI code.
5. **Model columns as `columnList → column[] → block[]` container blocks in the MIT core** — every system converges on this, and BlockNote gating it behind GPL/commercial is our differentiation opening.
6. **Separate the four block concerns explicitly** in the spec: `edit` (interactive view, per-framework), `renderStatic` (schema→HTML/Markdown without editor, TipTap-static-renderer style — this is also our SSR/export path), `parse` (import/paste rules), `commands/shortcuts`. Bindings (React/Vue/Svelte) wrap only `edit` and chrome.
7. **Storage "readable without the tool" = projection discipline, not format compromise**: canonical JSON tree persisted (file or SQLite), with a deterministic, lossless-where-possible Markdown projection (frontmatter/fenced JSON payloads for non-native blocks — Gutenberg's dual-format insight applied to Markdown) exercised continuously by tests, never hand-round-tripped as the source of truth.
8. **Build on ProseMirror concepts; strongly consider building on ProseMirror itself** for the web core (as BlockNote does), keeping our block-tree schema as the public API and PM as an internal engine detail — this preserves the option of a non-PM Swift implementation against the same schema, which is exactly BlockNote's projection architecture.
9. **Ship Notion-grade default chrome in the open core** (slash menu, side drag handle, selection toolbar, Tab-indent) with every component replaceable — BlockNote's batteries-included-but-headless inversion is the winning DX, and it's what "TanStack philosophy" means here: headless core, optional excellent defaults.
10. **Run screen-reader testing from the first interactive prototype** and budget for an external a11y audit before 1.0; adopt Tenon's Gutenberg findings (90 filed issues, all public) as a free checklist of block-editor-specific traps.
11. **Sustainability plan now**: keep core + columns + local collab MIT; if we monetize, follow the market's accepted line (hosted sync/collab service, AI) and never the Editor.js path of pure volunteer maintenance.

## Sources

- [Key concepts — Block Editor Handbook](https://developer.wordpress.org/block-editor/explanations/architecture/key-concepts/)
- [Block metadata (block.json) — Block Editor Handbook](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-metadata/)
- [Block deprecation — Block Editor Handbook](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-deprecation/)
- [@wordpress/block-serialization-default-parser](https://developer.wordpress.org/block-editor/packages/packages-block-serialization-default-parser/)
- [Issue #391: Block parsing and serialization — WordPress/gutenberg](https://github.com/WordPress/gutenberg/issues/391)
- [Gutenberg posts aren't HTML — Fluffy and Flakey](https://fluffyandflakey.blog/2017/09/04/gutenberg-posts-arent-html/)
- [What's so bad about HTML Comments as structure? — Greg Schoppe](https://gschoppe.com/wordpress/comments-arent-structure/)
- [Ask the Bartender: What Happens When Block Markup Changes? — WP Tavern](https://wptavern.com/ask-the-bartender-what-happens-when-block-markup-changes)
- [Parsing WordPress Block Data — DEV](https://dev.to/shelob9/parsing-wordpress-block-data-29am)
- [Access all block attributes structurally — Fluffy and Flakey](https://fluffyandflakey.blog/2022/12/06/access-all-block-attributes-structurally-with-the-gutenberg-block-editor/)
- [Beyond HTML Comments — GiveWP](https://givewp.com/beyond-html-comments-how-to-save-your-data-any-way-you-like-with-gutenberg/)
- [WPCampus releases results of the Gutenberg accessibility audit](https://wpcampus.org/blog/2019/05/gutenberg-audit-results/)
- [The WPCampus Gutenberg Accessibility Audit](https://wpcampus.org/learning/audit/)
- [WPCampus' Gutenberg Accessibility Audit Finds "Significant and Pervasive Accessibility Problems" — WP Tavern](https://wptavern.com/wpcampus-gutenberg-accessibility-audit-finds-significant-and-pervasive-accessibility-problems)
- [WPCampus Selects Tenon LLC for Gutenberg Accessibility Audit — WP Tavern](https://wptavern.com/wpcampus-selects-tenon-llc-for-wp-campus-gutenberg-accessibility-audit-completed-report-expected)
- [Postmortem Of Gutenberg The Launch — Smashing Magazine](https://www.smashingmagazine.com/2019/10/postmortem-gutenberg-launch-product/)
- [On Gutenberg and WordPress 5.0 — Yoast](https://yoast.com/on-gutenberg-and-wordpress-5-0/)
- [Gutenberg, 2 Years Later — CMS Critic](https://cmscritic.com/gutenberg-2-years-later-is-wordpress-better-off)
- [Editor.js](https://editorjs.io/)
- [Creating a Block Tool — Editor.js docs](https://editorjs.io/creating-a-block-tool/)
- [Is this project dying? — codex-team/editor.js Discussion #2381](https://github.com/codex-team/editor.js/discussions/2381)
- [Editor.js CHANGELOG](https://github.com/codex-team/editor.js/blob/next/docs/CHANGELOG.md)
- [Nested inline block — Discussion #2255](https://github.com/codex-team/editor.js/discussions/2255)
- [Nested blocks, for extracting links — Issue #1162](https://github.com/codex-team/editor.js/issues/1162)
- [How to nested blocks? — Issue #1440](https://github.com/codex-team/editor.js/issues/1440)
- [Fix for EditorJS nesting — PR #1055](https://github.com/codex-team/editor.js/pull/1055)
- [calumk/editorjs-columns](https://github.com/calumk/editorjs-columns)
- [editor-js/list issues](https://github.com/editor-js/list/issues)
- [BlockNote docs](https://www.blocknotejs.org/docs)
- [BlockNote — Document structure](https://www.blocknotejs.org/docs/foundations/document-structure)
- [BlockNote — Custom blocks](https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks)
- [BlockNote — Pricing](https://www.blocknotejs.org/pricing)
- [BlockNote — XL Commercial License](https://www.blocknotejs.org/legal/blocknote-xl-commercial-license)
- [BlockNote — About](https://www.blocknotejs.org/about)
- [TypeCellOS/BlockNote — GitHub](https://github.com/TypeCellOS/BlockNote)
- [Tiptap — Getting started overview](https://tiptap.dev/docs/editor/getting-started/overview)
- [Tiptap — Custom node extensions](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node)
- [Tiptap 3.0 is stable — release notes](https://tiptap.dev/blog/release-notes/tiptap-3-0-is-stable)
- [Tiptap — Static Renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer)
- [Tiptap — Pricing](https://tiptap.dev/pricing)
- [Tiptap 3.0 Beta — Launch YC](https://www.ycombinator.com/launches/NR5-tiptap-3-0-beta-the-next-gen-open-source-editor)
- [Is TipTap Free in 2026? Pricing Breakdown — Eddyter](https://eddyter.com/blogs/tiptap-pricing-explained-2026)
- [Community Extension: Resizable Multi Columns — ueberdosis/tiptap Discussion #6317](https://github.com/ueberdosis/tiptap/discussions/6317)
- [Multi column layout plugin — Issue #638](https://github.com/ueberdosis/tiptap/issues/638)
- [@tiptap-extend/columns — npm](https://www.npmjs.com/package/@tiptap-extend/columns)
- [Tiptap Conversion — Page structure](https://tiptap.dev/docs/conversion/content-types/page-layout/page-structure)
- npm registry metadata (versions, dates, licenses) for `@wordpress/blocks`, `@editorjs/editorjs`, `@blocknote/core`, `@blocknote/xl-multi-column`, `@tiptap/core` — https://registry.npmjs.org/
