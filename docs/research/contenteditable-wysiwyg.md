# contenteditable & WYSIWYG editing in the browser — the hard truths

Research note, August 2026. Basis for the editor-architecture decision of our Notion-style block editor (vanilla TS, headless core).

## TL;DR

- `contenteditable` is unfixable as a *complete* editor, but unavoidable as an *input surface*: every serious web editor (ProseMirror, Lexical, CKEditor 5, Notion, Medium, Google Docs pre-canvas) keeps it only as a capture layer and owns the document model itself.
- Nick Santos' classic Medium Engineering argument still holds: the DOM is a many-to-many mapping over what the user sees (many DOM shapes render identically; one visual caret position maps to several DOM positions), so "DOM as source of truth" is axiomatically broken.
- `document.execCommand()` is deprecated with no single successor; the replacement is a triad: `beforeinput` + Ranges for editing, the async Clipboard API for clipboard, and (Chromium-only so far) EditContext for IME-without-DOM.
- `beforeinput` is Baseline since March 2021 and most `inputType`s are cancelable — but the ones you need most on mobile are not: everything inside an IME composition (`insertCompositionText`) is non-cancelable by spec, and Android keyboards (GBoard above all) route *ordinary typing and even backspace* through composition.
- Ironclad rule: never mutate the DOM inside an active composition — the browser aborts the composition and drops or duplicates the user's input. Every mature editor defers model→DOM sync until `compositionend`, and uses a MutationObserver to find out what actually happened.
- Two viable architectures: (a) one contenteditable root + model-driven DOM reconciliation (ProseMirror, Lexical), (b) one contenteditable per text block, blocks composed around them (Notion — confirmed by direct DOM inspection —, Gutenberg, BlockSuite/AFFiNE).
- Per-block trades one huge problem (global DOM reconciliation under browser fire) for several small ones (cross-block selection, cross-block copy/paste, caret motion across blocks) — all of which have known, bounded solutions; Notion ships them.
- Browser extensions (Grammarly & co.) will mutate your editor DOM; your reconciler must treat the DOM as hostile territory and be able to revert foreign mutations without destroying user input.
- Recommendation (detailed at the end): per-block contenteditable leaves over a headless block-tree model — Notion's architecture, which also matches our schema-first, multi-renderer, native-Swift-later goals.

## Findings

### 1. Why raw contenteditable is unreliable — Nick Santos' actual arguments

["Why ContentEditable is Terrible"](https://medium.engineering/why-contenteditable-is-terrible-122d8a40e480) (Nick Santos, Medium Engineering, 2014) is the canonical indictment. Its core move is mathematical, not anecdotal: a well-behaved WYSIWYG editor needs three axioms, and contenteditable violates all three.

1. **Well-behaved content mapping (DOM → pixels must be injective up to equality).** Text that is bold+italic ("Baggins") has at least four visually identical DOM encodings: `<strong><em>Baggins</em></strong>`, `<em><strong>Baggins</strong></em>`, `<em><strong>Bagg</strong><strong>ins</strong></em>`, `<em><strong>Bagg</strong></em><strong><em>ins</em></strong>`. They *render* the same but *edit* differently — leaving invisible empty spans and split-tag artifacts users can feel but not see.
2. **Well-behaved selection mapping.** The visual-caret ↔ DOM-position mapping is many-to-many. A caret "before Baggins" in `<strong><em>Baggins</em></strong>` corresponds to three distinct DOM positions (before `<strong>`, inside `<strong>` before `<em>`, inside `<em>`), each giving different formatting to newly typed text. Line wrapping adds the inverse ambiguity: one DOM position, two visual caret locations (end of wrapped line vs start of next).
3. **Algebraically closed edits.** Browsers each normalize edits differently (WebKit's infamous `apple-style-span` era), so "write in Firefox, edit in Chrome, return to Firefox" mutates markup invisibly and non-deterministically.

Santos' conclusion: contenteditable fails because it tries to be a WYSIWYG editor *and* a general-purpose HTML editor at once — "conflicting requirements" — and it should instead be treated as a low-level platform to build editors on. That is exactly what the industry did.

The [CKEditor team's "ContentEditable — The Good, the Bad and the Ugly"](https://ckeditor.com/blog/ContentEditable-The-Good-the-Bad-and-the-Ugly/) corroborates from the trench view: selection, clipboard, and DnD APIs are "incomplete and/or inconsistent and buggy"; Blink/WebKit favor inline styles and have broken selection behaviors; Enter/typing semantics differ per browser. Their answer for CKEditor 5 was the same as everyone's: a custom data model, custom commands, custom undo, clipboard interception — contenteditable reduced to a rendering/input surface.

### 2. execCommand is dead; what replaced it

[MDN marks `document.execCommand()` deprecated/obsolete](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand); it was never a real standard (the [W3C draft](https://w3c.github.io/editing/docs/execCommand/) exists mainly to document the mess), and behavior always diverged per browser. Notable residue: execCommand edits integrate with the native undo stack, which nothing else fully replaces — one reason some editors still call it opportunistically ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)).

What replaced it, per the W3C Editing Taskforce direction:

- **Editing**: intercept [`beforeinput`](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event), `preventDefault()`, apply the edit to *your model*, re-render. Ranges/StaticRanges describe what would have changed.
- **Clipboard**: async [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand) replaces `execCommand('copy'/'paste')`.
- **Undo**: yours. Once you preventDefault, the native undo stack is empty/garbage; a model-level undo history is mandatory (every library ships one).
- **IME/low-level input**: the [EditContext API](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API) (§6) is the designed long-term successor for "text input without DOM coupling", still Chromium-only in 2026.

### 3. Input Events Level 2 / beforeinput — state in 2026

- **Support**: `beforeinput` is [Baseline, widely available since March 2021](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event) (Chrome/Edge, Safari, Firefox 87+). By ~2022 most of [Input Events Level 2](https://www.w3.org/TR/input-events-2/) was implemented in Chromium, and Level 2 was slimmed to match reality — three IME-specific input types (`deleteByComposition`, `deleteCompositionText`, `insertFromComposition`) were removed from the spec ([caniuse issue #4003 discussion](https://github.com/Fyrd/caniuse/issues/4003)).
- **`getTargetRanges()`** is the load-bearing API: for a cancelable `beforeinput` it returns `StaticRange`s describing exactly what DOM the browser *would* modify. That is your bridge from "browser intent" to "model transaction". Feature-detect Level 2 by `typeof InputEvent.prototype.getTargetRanges === "function"` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)).
- **Cancelability**: per [spec](https://w3c.github.io/input-events/), every `beforeinput` is cancelable **except** those emitted during IME composition — `insertCompositionText` is explicitly non-cancelable ("IME is one exception where input cannot be canceled due to various technical constraints", [w3c/input-events #115](https://github.com/w3c/input-events/issues/115)). MDN adds that autocomplete, spellcheck-correction acceptance, and password-manager autofill may fire non-cancelable `beforeinput` or none at all, varying by browser/OS.
- **Practical consequence** ([MDN's own recommendation](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)): `beforeinput` alone cannot give you full control. You must also handle `input`/mutations after the fact and be prepared to reconcile or revert what the browser did. Every production editor runs this two-layer scheme.

### 4. IME composition — the rules, and where Android lies

**The lifecycle**: `compositionstart` → n× `compositionupdate` (each paired with non-cancelable `beforeinput`/`input` of type `insertCompositionText`) → `compositionend`. During this window the *IME*, not the page, owns the text run under composition.

**Rule #1 — never mutate the DOM mid-composition.** The IME holds references into the text node being composed; replacing or re-rendering that node makes the browser abort the composition, typically dropping or duplicating input and dismissing the keyboard's candidate window. ProseMirror's entire composition subsystem exists to obey this: during composition it stops reconciling, lets the browser mutate freely, records everything through a **MutationObserver**, and only at `compositionend` (or forced flush) re-parses the mutated region and applies it to the model ([Composition overhaul](https://discuss.prosemirror.net/t/composition-overhaul/1923), [IME/Composition and flushing the DOM](https://discuss.prosemirror.net/t/ime-composition-and-flushing-the-dom/1756) — Marijn notes even a forced flush "may terminate the composition"). Lexical reconciles via `queueMicrotask` but likewise special-cases composition; its FAQ generalizes the lesson: input-source events "often don't reliably trigger a reliable event sequence" once IME, spellcheck, extensions and screen readers are involved ([Lexical FAQ](https://lexical.dev/docs/faq)).

**Android/GBoard specifics — where beforeinput lies:**

- On Android, *ordinary Latin typing* is composition: GBoard "composes whole English words like they were Chinese characters", and may move the selection from where the user tapped to the nearest word ([Lexical #3538](https://github.com/facebook/lexical/issues/3538)).
- **Backspace lies**: pressing Backspace during composition fires `beforeinput` of type `insertCompositionText` whose target range **replaces the entire word** — the event describes a whole-word replacement for a one-character deletion. CKEditor considered translating these back into delete events to avoid over-touching the model ([ckeditor5 #12456](https://github.com/ckeditor/ckeditor5/issues/12456)); they also had to explicitly re-stabilize basic Android typing on beforeinput ([ckeditor5 #8011](https://github.com/ckeditor/ckeditor5/issues/8011), [#12058](https://github.com/ckeditor/ckeditor5/issues/12058)).
- Android presents at least three input modes — cancelable virtual-key clicks, non-cancelable IME, non-cancelable non-IME — and **every keyboard app combines them differently** (GBoard ≠ Samsung Keyboard ≠ SwiftKey) ([w3c/input-events discussion](https://github.com/w3c/input-events/issues/115), [Lexical #3538](https://github.com/facebook/lexical/issues/3538)).
- Slate's Android rewrite ([slate #4988](https://github.com/ianstormtaylor/slate/pull/4988)) is the best public blueprint for coping: a MutationObserver-based `RestoreDOM` that reverts user-input mutations before the framework commits state; an input manager that stores intents as lightweight text `diff`s (no re-render) vs `action`s (need re-render); **deferred flushing** of diffs until composition ends; and scheduled timeouts for events that fire unreliably. Lexical's team resisted timeout hacks as "nondeterministic" and eventually shipped them anyway ([Lexical #3538](https://github.com/facebook/lexical/issues/3538)). Draft.js died partly on this hill ([draft-js #2035](https://github.com/facebook/draft-js/pull/2035)).
- Even in 2025–26 the churn continues: prosemirror-view's changelog is a running catalog of fresh composition workarounds (Chrome misreporting cursor position mid-composition, Safari moving composed text out of empty table cells, Chinese-IME + stored-marks breakage on Chrome) ([prosemirror-view CHANGELOG](https://github.com/ProseMirror/prosemirror-view/blob/master/CHANGELOG.md)).

**Net**: on desktop, `beforeinput` + preventDefault is a workable primary path. On Android it is not; the only robust strategy is "let the browser do it, observe mutations, reconcile after" — which your architecture must support *anyway*, so composition handling degenerates to: freeze reconciliation during composition, flush at the end.

### 5. Selection & Range APIs — mapping DOM ↔ model positions

The DOM gives you `Selection` (anchor/focus node+offset), `Range`/`StaticRange`, `document.caretPositionFromPoint()`, and `beforeinput.getTargetRanges()`. The editor's job is a bidirectional map between these and model positions.

- **ProseMirror's scheme** ([guide](https://prosemirror.net/docs/guide/)): the model is a tree, but *inline content is a flat sequence per block*, so positions are plain integers — position 0 before the first node, each character one token, each node boundary one token. `Node.resolve(pos)` turns an integer into a rich structure (ancestors, offsets); `view.domAtPos`/`posAtDOM`/`posAtCoords` cross the DOM boundary. On every DOM `selectionchange` while focused, PM re-derives the model selection from the DOM selection and vice versa after each transaction. Crucially, positions being integers makes **position mapping through document changes** (for undo, collab, decorations) cheap and well-defined.
- **The flat-sequence insight** matters for us: Santos' selection ambiguity (§1) disappears at the model level if inline text is a string + mark ranges, because "before Baggins" is a single integer offset; whether typed text is bold becomes an explicit editor policy (stored marks), not a DOM accident. Medium's model (§7) and Notion's (title/rich-text arrays per block) make the same move.
- **Cursor motion**: even ProseMirror lets the *browser* handle most arrow-key/mouse caret movement ("the browser is quite good at cursor and selection placement" — [guide](https://prosemirror.net/docs/guide/)), then reads the result back. Don't reimplement caret physics (bidi, grapheme clusters, line wrap) unless forced; for cross-block boundary moves you must intervene (§8).
- **2025-baseline additions**: `Selection.getComposedRanges()` (selection across shadow DOM, Baseline Aug 2025 — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Selection/getComposedRanges), [Chrome 137](https://developer.chrome.com/release-notes/137)) and `caretPositionFromPoint()` with `shadowRoots` option (Baseline Dec 2025 — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/caretPositionFromPoint)). Relevant if we ever render blocks in shadow roots (BlockSuite does, via web components); for light-DOM rendering they're a non-issue.

### 6. Browser landscape 2026 — what's still inconsistent, what's new

- **Still broken/divergent**: composition edge cases per browser+IME+keyboard (§4); selection behavior around `contenteditable=false` islands inside editable roots (ProseMirror ships gap-cursor as a workaround-turned-feature; [PM #553](https://github.com/ProseMirror/prosemirror/issues/553)); Chrome/Safari inserting bogus `<br>`s and normalizing whitespace during native edits; non-cancelable/absent beforeinput for autofill/spellcheck-accept ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)); Firefox bugs [1673558](https://bugzil.la/1673558)/[1763669](https://bugzil.la/1763669). The prosemirror-view changelog remains the best live registry of what currently misbehaves where.
- **`contenteditable="plaintext-only"`**: Baseline Newly Available since March 2025 (Firefox 136 was last; [web.dev](https://web.dev/blog/contenteditable-plaintext-only-baseline)). Big deal for per-block designs: a text leaf marked plaintext-only gets native editing/caret/IME but the browser will never inject rich markup — formatting stays 100% model-driven. (Gutenberg-style editors used to emulate this by fighting `insertFromPaste` normalization.)
- **EditContext API**: shipped Chrome/Edge 121 (Jan 2024), lets an element (even `<canvas>`) participate in the OS text-input/IME pipeline without contenteditable — explicitly designed to kill the hidden-contenteditable hacks Google-Docs-class editors use ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API), [explorer](https://web-platform-dx.github.io/web-features-explorer/features/edit-context/)). As of 2026: **still no Firefox or Safari** — Mozilla is "positive with concerns" (compat, a11y), WebKit position unknown. Watch it; don't build on it.
- **Safari** remains the laggard on beforeinput details and composition edge cases; **Android Chrome** remains the hardest input environment (§4). iOS Safari has its own keyboard-scroll/selection-handle quirks but is far closer to desktop Safari than Android Chrome is to desktop Chrome.

### 7. Architecture A — single contenteditable root, model-driven reconciliation (ProseMirror, Lexical, CKEditor 5)

One `contenteditable=true` root hosts the whole document. The editor keeps an immutable model (PM: `EditorState`/`Node` tree; Lexical: `EditorState` node map), applies edits as transactions, and a reconciler diffs model→DOM like a bespoke virtual DOM ([Build Your Own ProseMirror View](https://nytimes.github.io/oak-byo-react-prosemirror-redux/post/build-your-own-pm-view/), [ProseMirror guide](https://prosemirror.net/docs/guide/), [Lexical FAQ](https://lexical.dev/docs/faq)). Browser-initiated DOM changes (typing, spellcheck, IME) are detected (MutationObserver + events), re-parsed into the model, diffed into a transaction ([guide](https://prosemirror.net/docs/guide/)).

Strengths:
- **Native cross-block text selection, free.** One editing host = one browser selection spanning paragraphs, lists, headings. Copy/paste/drag of arbitrary document slices mostly rides native behavior.
- **One a11y tree**: screen readers see one text document; caret browsing works document-wide.
- **Mature ecosystems**: collab, decorations, node views, schema tooling.

Costs:
- **The reconciler bears the whole war.** Every browser quirk in §4/§6 plays out *inside your document*: the view layer must track which DOM the browser owns at any instant (composition), which it owns, and who wins. This is ProseMirror's largest, most patched module — a decade in, still gaining browser workarounds monthly ([CHANGELOG](https://github.com/ProseMirror/prosemirror-view/blob/master/CHANGELOG.md)).
- **Non-text islands are second-class**: embeds/tables/kanban inside the editable root need `contenteditable=false` + NodeView machinery, and native selection around them is buggy enough that PM invented gap cursors. A Notion-style database view *inside* one big editable root is misery ([HN discussion](https://news.ycombinator.com/item?id=36507525): "if the entire page is one big editable area, it becomes difficult to embed complex blocks like kanban views and calendar").
- **Whole-doc invariants**: one broken node view or one extension-injected element can corrupt parsing for the whole document, not one block.
- Framework interop friction (double-reconciliation with React/Vue) — irrelevant for our vanilla-TS core but relevant to our bindings story.

### 8. Architecture B — one contenteditable per text block (Notion, Gutenberg, BlockSuite)

**What Notion actually does — primary evidence.** Direct DOM inspection of a public notion.site page (Aug 2026, this research): a `.notion-page-content` root that is *not* contenteditable; 82 `div[data-block-id]` blocks; **65 separate leaf elements carrying their own `contenteditable` attribute plus `data-content-editable-leaf`** (the page title is such a leaf as an `<h1>`); non-text content wrapped in `contenteditable=false` elements marked `data-content-editable-void`. I.e., Notion is textbook per-block: each text run is its own tiny editable host, everything else is inert DOM composed around them. Secondary sources agree: Notion is a custom contenteditable codebase (no ProseMirror/Slate), each text block an independent React component with its own contenteditable div, and **cross-block selection triggers block-level highlighting instead of native text selection** ([TechAhead breakdown](https://www.techaheadcorp.com/blog/tech-stack-powering-notion-block-based-editor/), [Notion's data-model post](https://www.notion.com/blog/data-model-behind-notion) for the block/operation/transaction model).

**Gutenberg** (WordPress) is the other production-scale per-block editor and documents its cross-block selection technique precisely ([writing-flow readme](https://github.com/WordPress/gutenberg/blob/trunk/packages/block-editor/src/components/writing-flow/readme.md), [#3629](https://github.com/WordPress/gutenberg/issues/3629)): browsers allow only one focused editable at a time, so by default cross-block native selection is impossible; Gutenberg *temporarily flips container contentEditable on* to let native selection flow across blocks while preventDefault-ing everything but selection — on mouse-leave of an editable field, on shift-click mousedown, on keyboard selection reaching a field edge — then reads `selectionchange` to sync (blockId, attribute, offset) tuples into its store.

**BlockSuite/AFFiNE** rebuilt this stack greenfield (2023→): "breaks down rich content into discrete contenteditable blocks, avoiding pitfalls of the traditional monolithic rich text container"; each block's text is an independent `InlineEditor` over a `Y.Text` delta, "eliminating nesting between rich text instances", which they report "significantly reduces the complexity required to implement traditional rich text editing" ([BlockSuite overview](https://blocksuite.io/guide/overview), [@blocksuite/inline](https://blocksuite.io/guide/inline), [Working with Block Tree](https://blocksuite.io/guide/working-with-block-tree.html)).

Honest comparison against Architecture A:

| Concern | Single root (PM/Lexical) | Per-block (Notion/Gutenberg/BlockSuite) |
|---|---|---|
| Same-block editing & IME | Reconciler must scope browser chaos itself | **Naturally contained**: one composition can only corrupt one small leaf; blast radius = one block |
| Cross-block *text* selection | **Native, free** | Not native; either Notion's model (escalate to block-selection overlay) or Gutenberg's toggle trick |
| Copy/paste across blocks | Mostly native + clipboard sanitization | Fully custom: serialize selected model slice to clipboard (HTML+ custom MIME); intercept paste |
| Caret motion across blocks | Native | Custom: detect caret at leaf edge, move focus to adjacent leaf preserving X-offset (Notion does this; small, well-understood code) |
| Complex embeds (db views, kanban, columns) | Painful (ce=false islands, gap cursors, NodeViews) | **Trivial: just DOM**; blocks are ordinary components |
| A11y | One document in the a11y tree; best for continuous prose | Many small text boxes + application-style shell; needs deliberate ARIA + roving focus work, but Notion/Gutenberg prove it shippable |
| Undo/redo | Model-level (mandatory in both) | Model-level (mandatory in both) |
| Extension interference | One corruption can garble whole-doc parsing | Corruption contained per leaf; inert shell unaffected |
| Framework bindings | View layer must own all DOM (fights host frameworks) | Blocks render with anything (React/Vue/lit/vanilla); only leaves are special |
| Drag/reorder, virtualization of long docs | Hard inside one editable | Natural: blocks are list items |
| Matches our schema-first, multi-renderer, native-Swift-later plan | Model is editor-library-shaped | **Block tree = our storage schema = our render tree** |

The [HN thread on per-block editors](https://news.ycombinator.com/item?id=36507525) states the trade succinctly: per-block loses native cross-block selection; monolithic loses easy complex embeds. Notion's product answer — cross-block selection *becomes block selection* (whole blocks highlighted, operations act on block ranges) — is not a workaround but a feature: it matches the block mental model, makes multi-block operations (move, delete, indent, turn-into) trivially well-defined, and sidesteps the hardest DOM problem entirely.

### 9. Medium's editor architecture (the model that made the article famous)

From [Santos' article](https://medium.engineering/why-contenteditable-is-terrible-122d8a40e480): Medium keeps a parallel model — sections → paragraphs, where a paragraph is a **plain text string + markup ranges + metadata** (exactly the flat-inline representation of §5), with the invariant "two models have the same visual rendering iff the models are equal". All edits reduce to **six operations** (Insert/Remove/Update × Paragraph/Section). DOM↔model mappings are split into "indoor" (editor-produced DOM, lossless one-to-one) and "outdoor" (pasted/foreign HTML, deliberately lossy: text first, then bold/italic/links). Input handling is hybrid: critical keys (Enter, Delete, paste, type-over-selection) are intercepted and translated to operations; ordinary typing is left to contenteditable, then the DOM is mapped back and diffed against the model. This 2014 design is the ancestor of everything above — and is essentially per-paragraph normalization within a single editable, later generation editors just pushed it further in one of the two directions of §7/§8.

### 10. Spellcheck, Grammarly, and extension DOM interference — defenses

Extensions inject DOM wherever the caret lands. Grammarly wraps/overlays text with its own elements and attributes, and historically mutated "any DOM where the cursor lands" — Kayako documented it silently breaking Ember/Glimmer's stable-DOM assumption app-wide, with `data-gramm="false"` *not* reliably honored, and resolution requiring being manually blocklisted by Grammarly ([Browser Extensions: a Cautionary Tale](https://medium.com/kayako-engineering/why-we-parted-ways-with-grammarly-and-you-should-too-dea483bef823)). Grammarly's own engineering blog confirms the mechanism (an overlay+mutation strategy per site) ([Making Grammarly Feel Native](https://www.grammarly.com/blog/engineering/making-grammarly-feel-native-on-every-website/)). GitLab hit ProseMirror infinite loops from extension mutations ([GitLab MR 77965](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/77965)).

Defenses used in practice:
- Attributes on editable hosts: `data-gramm="false"` (plus legacy `data-gramm_editor`, `data-enable-grammarly="false"`), `spellcheck` toggling, `autocorrect`/`autocapitalize` control. Helpful, not sufficient ([Kayako](https://medium.com/kayako-engineering/why-we-parted-ways-with-grammarly-and-you-should-too-dea483bef823)).
- **Reconciler-level immunity**: ProseMirror treats unexpected DOM as stale and reverts it from the model ([WebSpellChecker's analysis](https://medium.com/beyond-webspellchecker/befriending-wysiwyg-editors-text-highlighting-with-virtual-underlines-48c80a680b2f)); Slate's RestoreDOM reverts foreign mutations pre-commit ([slate #4988](https://github.com/ianstormtaylor/slate/pull/4988)). Rule: never crash or corrupt on unknown nodes — parse what you recognize, drop what you don't, restore canonical DOM.
- Per-block architecture shrinks the attack surface: extensions target focused editable regions; a small leaf is cheap to re-render from the model wholesale.
- Native `spellcheck=true` is safe with model-driven editors only because corrections arrive as (sometimes non-cancelable) input/mutations — which your §4 machinery already reconciles. Turn spellcheck *off* on leaves under composition-sensitive operations if you see conflicts.

## Pitfalls (what prior art teaches us NOT to do)

1. **Do not use the DOM as the document model.** Every argument in §1; every successful editor since 2014 agrees. The model is authoritative; DOM is a projection.
2. **Do not rely on `beforeinput`+`preventDefault` as your only input path.** Non-cancelable IME events, lying Android target ranges, absent events for autofill/spellcheck (§3–4) make a mutation-reconciliation fallback mandatory. Plan for both from day one — Slate and Lexical both had to bolt Android support on later, painfully.
3. **Never touch the DOM during composition** — no re-render, no normalization, no decoration updates in the composed region. Defer to `compositionend`. Violation = dropped/duplicated user text and dismissed IME candidates (§4).
4. **Do not trust one Android keyboard's behavior as "Android behavior."** GBoard/Samsung/SwiftKey each mix cancelable and non-cancelable modes differently; test matrix, not assumptions (§4).
5. **Do not build on execCommand** (dead), and **do not build on EditContext yet** (Chromium-only in 2026, Mozilla ambivalent, WebKit silent) (§2, §6).
6. **Do not attempt document-wide DOM reconciliation unless you're prepared to maintain it forever.** ProseMirror's view layer is a decade of accumulated browser workarounds and still patches monthly; reproducing that in-house is the single most expensive path we could choose (§7).
7. **Do not put complex interactive widgets inside an editable root.** ce=false islands break native selection; gap-cursor hacks follow. Compose widgets *around* editables instead (§7–8).
8. **Do not forget the native undo stack dies the moment you preventDefault.** Model-level undo (with position mapping) is table stakes, and per-block undo must still be document-global (a Notion lesson: undo crosses blocks).
9. **Do not assume your DOM stays yours.** Extensions will mutate it; reconcile-or-revert, never crash, never persist foreign nodes into the model (§10).
10. **Do not reimplement caret physics.** Let the browser move the caret inside a leaf (bidi, graphemes, wrapping); intervene only at block boundaries (§5, §8).
11. **Do not make pasted HTML lossless.** Medium's "outdoor mapping" lesson: sanitize aggressively to your schema (text, then a small whitelist of marks/blocks); lossy is correct (§9).
12. **Do not treat cross-block *text* selection as a must-have invariant.** Notion ships block-escalation selection and users accept it; chasing Gutenberg's contenteditable-toggling trick is a valid later enhancement, not a foundation requirement (§8).

## Recommendations for our editor

Opinionated bottom line: **Architecture B — per-block contenteditable leaves over a headless block-tree core.** It is what Notion does (verified), what BlockSuite chose after studying this exact history, and the only option whose model layer is *identical* to our storage schema and future native-Swift renderer. It contains browser chaos to paragraph-sized sandboxes instead of betting the project on a document-wide reconciler competing with ProseMirror's decade head start. Concretely:

1. **Headless core = block tree + flat inline model.** Blocks: id (UUID), type, props, children — mirroring Notion's operation/transaction data model, which also maps cleanly to Markdown/CSV/SQLite storage. Inline text per block: string + mark ranges (delta-style), so model positions are `(blockId, offset)` integers — Santos-proof by construction, trivially serializable, and CRDT-ready (BlockSuite proves Y.Text-per-leaf works for later p2p sync).
2. **Leaf editor as its own small module** (our `InlineEditor` ≈ BlockSuite's `@blocksuite/inline`): owns one contenteditable element, renders deltas → spans, handles `beforeinput` (preventDefault + model op when cancelable), `getTargetRanges()` for range mapping, and a MutationObserver + composition freeze/flush for the non-cancelable path. This module is ~the only place browser warfare lives; keep it dependency-free and brutally tested.
3. **Use `contenteditable="plaintext-only"` on leaves** (Baseline since 2025-03) so the browser can never inject rich markup; all formatting flows through the model. Feature-detect and fall back to `contenteditable=true` + normalization on old engines.
4. **Selection model with two states**: (a) text selection = native selection within one leaf, mirrored to `(blockId, start, end)`; (b) block selection = our own overlay over a block range, entered when selection would cross a leaf boundary (Notion behavior). Design the selection type as a tagged union now; optionally add Gutenberg's temporary-contenteditable trick for native-feeling cross-block text selection later.
5. **Custom clipboard from day one**: intercept copy/cut/paste; write `text/plain` + `text/html` + a custom JSON MIME of the model slice; paste = sanitize foreign HTML through a lossy "outdoor" importer (Medium's pattern) and accept our own MIME losslessly.
6. **Document-global, model-level undo** with position mapping; group ops into transactions (Notion's op/transaction model) — this doubles as the sync/collab substrate later.
7. **Caret motion at boundaries**: intercept Arrow/Home/End/Backspace/Delete at leaf edges to move focus across blocks (preserving goal X for up/down), merge/split blocks on Backspace/Enter. Everything inside a leaf stays native.
8. **Defensive DOM posture**: `data-gramm="false"` and friends on leaves, model-revert of unrecognized mutations, never crash on foreign nodes; re-render a whole leaf from the model whenever it drifts.
9. **Test matrix as a first-class artifact**: desktop Chrome/Firefox/Safari + Android Chrome with GBoard *and* Samsung Keyboard + iOS Safari; scripted IME scenarios (Japanese conversion, Chinese pinyin, Korean, GBoard English autocorrect, mid-word backspace). This is where per-block pays: the surface under test is one leaf, not a document.
10. **Track EditContext** (Chromium-only today): if/when Firefox and Safari ship it, leaves could migrate from contenteditable to EditContext-backed rendering with the same model — our leaf-module boundary makes that swap local.

## Sources

- [Why ContentEditable is Terrible — Nick Santos, Medium Engineering](https://medium.engineering/why-contenteditable-is-terrible-122d8a40e480)
- [ContentEditable — The Good, the Bad and the Ugly — CKEditor](https://ckeditor.com/blog/ContentEditable-The-Good-the-Bad-and-the-Ugly/)
- [Document.execCommand() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)
- [execCommand — W3C editing draft](https://w3c.github.io/editing/docs/execCommand/)
- [Element: beforeinput event — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)
- [Input Events Level 2 — W3C](https://www.w3.org/TR/input-events-2/)
- [Input Events cancelability of insertCompositionText — w3c/input-events #115](https://github.com/w3c/input-events/issues/115)
- [Input Events Level 1 and 2 — caniuse #4003](https://github.com/Fyrd/caniuse/issues/4003)
- [contenteditable plaintext-only is Baseline — web.dev](https://web.dev/blog/contenteditable-plaintext-only-baseline)
- [EditContext API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API)
- [EditContext — web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/edit-context/)
- [Selection.getComposedRanges() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Selection/getComposedRanges)
- [Document.caretPositionFromPoint() — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/caretPositionFromPoint)
- [Chrome 137 release notes (getComposedRanges)](https://developer.chrome.com/release-notes/137)
- [ProseMirror Guide](https://prosemirror.net/docs/guide/)
- [ProseMirror view CHANGELOG (living browser-quirk registry)](https://github.com/ProseMirror/prosemirror-view/blob/master/CHANGELOG.md)
- [Composition overhaul — discuss.ProseMirror](https://discuss.prosemirror.net/t/composition-overhaul/1923)
- [IME / Composition and flushing the DOM — discuss.ProseMirror](https://discuss.prosemirror.net/t/ime-composition-and-flushing-the-dom/1756)
- [Build Your Own ProseMirror View — NYTimes](https://nytimes.github.io/oak-byo-react-prosemirror-redux/post/build-your-own-pm-view/)
- [ContentEditable=false NodeViews selection issues — ProseMirror #553](https://github.com/ProseMirror/prosemirror/issues/553)
- [Lexical FAQ](https://lexical.dev/docs/faq)
- [GBoard cursor jump — facebook/lexical #3538](https://github.com/facebook/lexical/issues/3538)
- [GBoard select-all delete — facebook/lexical #5259](https://github.com/facebook/lexical/issues/5259)
- [CJK composition broken in Android Firefox — facebook/lexical #6377](https://github.com/facebook/lexical/issues/6377)
- [Android/IME: translate composition events to delete events — ckeditor5 #12456](https://github.com/ckeditor/ckeditor5/issues/12456)
- [Stabilize composition using beforeInput on Android — ckeditor5 #8011](https://github.com/ckeditor/ckeditor5/issues/8011)
- [Bring back basic typing on Android — ckeditor5 #12058](https://github.com/ckeditor/ckeditor5/issues/12058)
- [Android input handling rewrite — ianstormtaylor/slate #4988](https://github.com/ianstormtaylor/slate/pull/4988)
- [Fixing major Android editing issues — draft-js #2035](https://github.com/facebook/draft-js/pull/2035)
- [Gutenberg writing-flow readme (cross-block selection mechanics)](https://github.com/WordPress/gutenberg/blob/trunk/packages/block-editor/src/components/writing-flow/readme.md)
- [Gutenberg cross-block selection — WordPress/gutenberg #3629](https://github.com/WordPress/gutenberg/issues/3629)
- [Per-block editors tradeoffs — Hacker News](https://news.ycombinator.com/item?id=36507525)
- [The data model behind Notion's flexibility — Notion](https://www.notion.com/blog/data-model-behind-notion)
- [How Notion Was Built — HowWorks](https://howworks.ai/blog/how-notion-was-built)
- [Tech stack behind Notion's block editor — TechAhead](https://www.techaheadcorp.com/blog/tech-stack-powering-notion-block-based-editor/)
- Primary DOM inspection of a public notion.site page (this research, Aug 2026): per-leaf `contenteditable` + `data-content-editable-leaf`, `data-content-editable-void`, non-editable `.notion-page-content` root
- [BlockSuite Framework Overview](https://blocksuite.io/guide/overview)
- [@blocksuite/inline — BlockSuite](https://blocksuite.io/guide/inline)
- [Working with Block Tree — BlockSuite](https://blocksuite.io/guide/working-with-block-tree.html)
- [Browser Extensions: a Cautionary Tale (Grammarly) — Kayako Engineering](https://medium.com/kayako-engineering/why-we-parted-ways-with-grammarly-and-you-should-too-dea483bef823)
- [Making Grammarly Feel Native On Every Website — Grammarly Engineering](https://www.grammarly.com/blog/engineering/making-grammarly-feel-native-on-every-website/)
- [Befriending WYSIWYG Editors: virtual underlines — WebSpellChecker](https://medium.com/beyond-webspellchecker/befriending-wysiwyg-editors-text-highlighting-with-virtual-underlines-48c80a680b2f)
- [Fix infinite loop in Content Editor codeblocks — GitLab MR 77965](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/77965)
- [Build a Notion-Style Block Editor in React (2026) — Eddyter](https://eddyter.com/blogs/build-notion-style-block-editor-react-2026)
