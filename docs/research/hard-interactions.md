# The Hard Interaction Problems Every Block Editor Must Solve

Research note, August 2026. Covers undo/redo, clipboard, drag & drop, selection, accessibility, and performance — the six interaction domains where block editors live or die. Sources are ProseMirror/Lexical/BlockNote source code and docs, Notion's public behavior and engineering blog, Atlassian's Pragmatic drag-and-drop, and the Gutenberg accessibility audit.

## TL;DR

- **Undo/redo has two proven architectures**: inverse operations (ProseMirror: each step stores its invert, enabling *selective* undo that survives collaboration) and immutable state snapshots (Lexical: copy-on-write EditorStates). Notion's own model — operations batched into transactions — is command-pattern shaped and is the natural fit for us, since we already want an op log for sync.
- **Keystroke coalescing is policy, not mechanism**: both PM (`newGroupDelay` 500ms) and Lexical (`delay` 300ms) merge adjacent typing into one undo step and break the group on selection moves, focus loss, pauses, and structural edits. Undo entries must carry a *selection bookmark* so undo restores the caret.
- **Clipboard = write three representations, read a priority list.** Every serious editor writes a lossless internal format plus `text/html` plus `text/plain` (BlockNote's plain text is actually Markdown). Internal fidelity is smuggled through `text/html` attributes (ProseMirror's `data-pm-slice`, Figma's base64 `data-buffer`) because custom MIME types don't survive the OS clipboard portably.
- **Paste is a parsing war**: Word ships `mso-*` pseudo-CSS and conditional comments; Google Docs wraps everything in `<b id="docs-internal-guid-…" style="font-weight:normal">` and ships lists as styled paragraphs. Detect the source, normalize per-source, sanitize (DOMPurify-class, at injection point) — pasted HTML is an XSS vector with real CVEs (Joplin).
- **Drag & drop is a genuine fork in the road**: HTML5 native DnD (BlockNote, Atlassian Pragmatic DnD — free cross-window/file interop, OS-composited previews) vs pointer-event dragging (touch support, controllable previews, auto-scroll, multi-block ghosts — what Notion's UX implies). For Notion-grade block dragging with column creation, pointer events win; keep native DnD only for external file drop-in.
- **Selection is a dual model and must be first-class core state**: text selection inside blocks vs block selection of whole blocks (Notion: Esc selects the block, arrows move, Shift+arrows/Shift+click extend). ProseMirror encodes this as TextSelection/NodeSelection/GapCursor classes; BlockNote had to add its own MultipleNodeSelection. Enter/Backspace are schema-aware split/merge commands, never browser defaults.
- **Accessibility: the Gutenberg/Tenon audit is the canonical cautionary tale** — semantically clean markup, yet "consistently poor" UX failing 30 WCAG 2.1 criteria. The fix that worked: separate Navigation mode (one Tab stop, arrows move between blocks) and Edit mode, toggled by Enter/Escape; keyboard/menu alternatives for every drag interaction.
- **Performance: don't virtualize first.** DOM windowing breaks Ctrl+F, the accessibility tree, and anchor links. `content-visibility: auto` gives most of the win (45% render improvement in a 20k-node case study) while keeping find-in-page and the a11y tree intact. Blocks are the perfect unit for it.
- **Watch EditContext**: as of 2026 it decouples text input (IME, etc.) from DOM in Chromium only; Mozilla is positive, Safari unknown. Architect input handling behind an abstraction so it can be adopted later.

## Findings

### 1. Undo/Redo

#### 1.1 Three architectures

**(a) Inverse operations (ProseMirror).** Every edit is a `Step`; `step.invert(docBefore)` produces the step that undoes it. The history plugin "observ[es] transactions and stor[es] their inverse" ([ProseMirror Guide](https://prosemirror.net/docs/guide/)). Crucially, PM's history is *selective*: "it does not just roll back to a previous state but can undo some changes while keeping other, later changes intact. (This is necessary for collaborative editing, and comes up in other situations as well.)" ([prosemirror-history reference](https://prosemirror.net/docs/ref/#history)). Selectivity works because stored inverse steps can be *rebased* (mapped through the position maps of later steps) before being applied.

**(b) Immutable snapshots (Lexical).** Lexical stores full `EditorState` snapshots per history entry, cheap because states share structure via a copy-on-write NodeMap; "after an update, the editor state is locked and deemed immutable" ([Lexical: Editor State](https://lexical.dev/docs/concepts/editor-state), [Lexical: History](https://lexical.dev/docs/concepts/history)). Simpler to reason about, but naive snapshot-undo rolls back *everything* — it cannot do selective undo, which is why snapshot-based undo breaks down under real-time collaboration unless entries are diffed back into operations.

**(c) Operation log (Notion).** Notion's client expresses every user action as **operations** (each modifying a single record) batched into **transactions** committed atomically ([The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)). Undo is then "apply the inverse transaction" — command pattern at the document-model level rather than the editor level. Public behavior: Cmd+Z reverses one transaction at a time and history is scoped to the current client session ([super.so guide](https://super.so/blog/how-to-undo-in-notion-across-devices)).

**(d) CRDT-scoped undo (Yjs), relevant to our sync future.** `Y.UndoManager` tracks changes by transaction *origin* (`trackedOrigins`), so each user undoes only their own edits in a shared doc ([Y.UndoManager docs](https://docs.yjs.dev/api/undo-manager)). Known sharp edge: interleaved untracked remote changes can block local undo in some scenarios ([yjs#273](https://github.com/yjs/yjs/issues/273)).

#### 1.2 Grouping / coalescing keystrokes

- ProseMirror: `newGroupDelay` — "The delay between changes after which a new group should be started. Defaults to 500 (milliseconds). Note that when changes aren't adjacent, a new group is always started." Depth default 100 events. `closeHistory(tr)` forcibly ends the current group; `"addToHistory": false` metadata excludes a transaction from undo entirely (used for remote/collab transactions) ([reference](https://prosemirror.net/docs/ref/#history)).
- Lexical: `delay` (default 300ms) is "the merge window during which adjacent edits collapse into the current history entry." Continuous typing = forward character input, backspace, forward delete; **anything else breaks the group**: hard returns, selection moves (arrows, word-select), focus loss, timeout, composed character sequences (IME/diacritics/emoji), copy/paste ([Lexical: History](https://lexical.dev/docs/concepts/history)).
- Both agree on the invariants: merge only *adjacent* text edits; structural operations (split, merge, move, delete block) always start a new undo step.

#### 1.3 Restoring selection on undo

prosemirror-history stores a `SelectionBookmark` alongside the first inverted step of each event: "An item that has both a step and a selection bookmark is the start of an 'event' — a group of changes that will be undone or redone at once" (source comment, [history.ts](https://code.haverbeke.berlin/prosemirror/prosemirror-history)). On undo the bookmark is *mapped through the remapping* before being resolved, so it stays correct even after later edits. Lexical gets this for free — the snapshot contains the selection. Lesson: an undo entry = {inverse ops, selection-before, selection-after}, with positions stored in a mapping-safe form (block ID + offset for us, not absolute indices).

### 2. Clipboard

#### 2.1 What goes on the clipboard on copy

The clipboard holds multiple representations keyed by MIME type; consumers pick the richest they understand ([The web's clipboard — alexharri](https://alexharri.com/blog/clipboard)). What real editors write:

- **ProseMirror** (`serializeForClipboard` in [prosemirror-view/clipboard.ts](https://github.com/ProseMirror/prosemirror-view/blob/master/src/clipboard.ts)): `text/html` = DOM-serialized slice wrapped in a div carrying `data-pm-slice="${openStart} ${openEnd} ${-wrappers} ${JSON.stringify(context)}"` — open depths record *unclosed* node boundaries at the slice edges (half a blockquote, part of a list), and context records ancestor types so paste can re-wrap. Table fragments get re-wrapped (`td` → `["table","tbody","tr"]`) because bare cell markup won't parse. `text/plain` = `clipboardTextSerializer` hook or text content joined with `\n\n`.
- **BlockNote** writes three formats on both copy and block-drag: `blocknote/html` (lossless internal HTML), `text/html` (cleaned "external" HTML via a dedicated exporter), and `text/plain` — which is actually **Markdown** (`cleanHTMLToMarkdown(externalHTML)`), a deliberate choice so pasting into a plain-text context yields structured Markdown ([dragging.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/dragging.ts), [copyExtension.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/api/clipboard/toClipboard/copyExtension.ts)). Table selections are wrapped in `<table>` "to ensure correct parsing by spreadsheet applications."
- **Figma** smuggles its binary schema through `text/html`: `data-metadata` and `data-buffer` attributes carrying base64 (Kiwi format), because `text/html` maps to a native OS clipboard format everywhere while custom types don't ([alexharri](https://alexharri.com/blog/clipboard)).
- **Notion** popularized cross-block *partial* text copy: since Jan 2022 you can "select, cut, copy & paste partial text across paragraphs, bullet lists, callouts & more — without having to select each block in its entirety" — shipped on every platform *except Firefox*, where Notion was "actively working with the Mozilla team" ([Notion release notes 2022-01-19](https://www.notion.com/releases/2022-01-19)). Notion also writes an internal block format alongside `text/html` (observable in DevTools; not publicly documented), which is why block copies round-trip losslessly between Notion pages but degrade to HTML/Markdown elsewhere.

Platform constraints: the async Clipboard API only guarantees `text/plain`, `text/html`, `image/png`; arbitrary types throw. Chromium ≥104 adds **web custom formats** — write `ClipboardItem` types prefixed with `"web "` (e.g. `web application/json`), stored unsanitized with an OS-level mapping ([Chrome: Web custom formats](https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api/)). Chromium ≥120 adds an `unsanitized` read option for `text/html` ([Chrome docs](https://developer.chrome.com/docs/web-platform/unsanitized-html-async-clipboard)). Neither is cross-browser in 2026 — the old `ClipboardEvent.clipboardData.setData()` path (which allows any type inside a user-triggered copy handler) plus HTML-attribute smuggling remains the portable answer ([alexharri](https://alexharri.com/blog/clipboard)).

#### 2.2 Paste: reading priority and source normalization

BlockNote's accepted-types list is a good template — checked in this order: `vscode-editor-data` (VS Code's format, carries the language → paste as code block), `blocknote/html`, `text/markdown`, `text/html`, `text/plain`, `Files` ([acceptedMIMETypes.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/api/clipboard/fromClipboard/acceptedMIMETypes.ts)).

Source-specific HTML quirks that a paste pipeline must normalize ([Unwrite: cleaning Word/Google Docs HTML](https://unwrite.co/blog/clean-html-pasted-from-word-google-docs/), [CKEditor 5: Paste from Google Docs](https://ckeditor.com/docs/ckeditor5/latest/features/pasting/paste-from-google-docs.html)):

- **Word**: `MsoNormal`/`MsoListParagraph` classes; `xmlns:o/w/m` namespaces; fake CSS props prefixed `mso-` (round-trip data, not styling); `<!--[if gte mso 9]>` conditional comment blocks full of Office XML; aggressive inline font/margin styles on every element; lists sometimes expressed as styled paragraphs with `mso-list` markers.
- **Google Docs**: everything wrapped in `<b id="docs-internal-guid-…" style="font-weight:normal">` (the bold tag is a container, not emphasis — you must not interpret it as bold); one bold word can arrive as three nested `<span>`s with inline styles; all styling inline, zero classes; lists occasionally arrive as manually-numbered paragraphs.
- Detection is cheap and reliable: match `docs-internal-guid` / `mso-` signatures, then run a per-source normalizer before the generic HTML→schema parser. WebKit adds its own noise on *copy*: it replaces regular spaces with `&nbsp;` in spans, which ProseMirror explicitly reverses on paste (`restoreReplacedSpaces`, [clipboard.ts](https://github.com/ProseMirror/prosemirror-view/blob/master/src/clipboard.ts)).

**Paste-as-Markdown detection**: when only `text/plain` is available (or the HTML is trivial), run a heuristic over the text — Tiptap's example checks `^#{1,6}\s` headings, `\*\*…\*\*` bold, `\[…\](…)` links, `^[-*+]\s` list markers — and if it "looks like Markdown," parse it as Markdown instead of inserting as plain text ([Tiptap Markdown examples](https://tiptap.dev/docs/editor/markdown/examples)). GitLab shipped the same feature for its content editor ([gitlab#337145](https://gitlab.com/gitlab-org/gitlab/-/issues/337145)). BlockNote skips the heuristic when an explicit `text/markdown` type is present. False-positive management matters (a lone `#hashtag` is not a heading); require either a line-start block pattern or ≥2 distinct pattern hits, and offer undo-friendly "paste as plain text" (Cmd+Shift+V).

#### 2.3 Security of pasted HTML

Pasted HTML is untrusted input. Real-world example: Joplin RCE-capable XSS from crafted pasted content ([GHSA-m59c-9rrj-c399](https://github.com/laurent22/joplin/security/advisories/GHSA-m59c-9rrj-c399)); classic vectors are `onload`/`onerror` attributes on pasted `<img>`, `javascript:` hrefs, and obfuscated markup that regex sanitizers miss. Rules that hold up:

- Sanitize with a DOM-based sanitizer (DOMPurify-class) *at the point of injection*, never regex ([DOMPurify](https://dompurify.com/how-does-dompurify-ensure-that-sanitized-html-is-safe-for-injection-into-the-dom/)).
- Better: never inject pasted HTML at all — **parse it into the document schema** (the ProseMirror/BlockNote approach). A schema whitelist ("only these node types, only these attributes") is a structurally stronger sanitizer than tag filtering; the paste pipeline then re-serializes from the schema, so unknown markup simply cannot survive. Sanitization is still needed anywhere raw HTML is retained (e.g., an "embed HTML" block).
- Don't rely on browser clipboard sanitization: it exists for the async API but is inconsistent, and Chromium's `unsanitized` read bypasses it by design ([Chrome docs](https://developer.chrome.com/docs/web-platform/unsanitized-html-async-clipboard)).

### 3. Drag & Drop

#### 3.1 HTML5 DnD vs pointer-event dragging — the real trade-off

Two respectable camps exist, and both have modern flagship implementations:

**Native HTML5 DnD.** Atlassian's Pragmatic drag and drop deliberately builds on it: "Pragmatic drag and drop is powered by the web platform's built-in drag and drop functionality… embracing the web platform unlocks huge speed and flexibility wins," including free cross-window and OS-level drags and no per-frame JS for the preview ([Designed for delight, built for performance](https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance)). BlockNote also uses it: its drag handle calls `dataTransfer.setData(...)` with three formats and `dataTransfer.setDragImage(...)` on a cloned DOM subtree ([dragging.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/dragging.ts)). The costs are real and documented: **no touch support** ("Chrome, Firefox, and Safari all require a mouse to start a drag"), `getData()` returns nothing during `dragover` (you must mirror drag state in JS), the drag preview is a static snapshot you can't restyle mid-drag (built-in ~0.95 opacity and shadow you can't remove), limited cursor control, and no reliable scrolling during drag ([HTML5 DnD — the API that is gaslighting you](https://www.sam.today/blog/html5-dnd-the-api-that-is-gaslighting-you), [Atlassian: web platform design constraints](https://atlassian.design/components/pragmatic-drag-and-drop/web-platform-design-constraints/)). Even Atlassian ships a separate [auto-scroll package](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop-auto-scroll) because native auto-scroll is inconsistent across browsers.

**Pointer-event dragging.** `setPointerCapture()` keeps events flowing to the drag source; `document.elementsFromPoint()` does hit-testing under the cursor; the "preview" is just a positioned DOM element you fully control ([sam.today](https://www.sam.today/blog/html5-dnd-the-api-that-is-gaslighting-you)). This buys: touch/pen support, live multi-block previews with count badges, custom drop-indicator logic, controlled auto-scroll, and identical behavior across browsers. It costs: you implement everything (threshold before drag starts, scroll, cancel on Escape, a11y) and you lose native cross-app drag-out unless you add it separately.

**What Notion does**: not publicly documented. Observable behavior — fully styled preview following the cursor, smooth edge auto-scroll, multi-block drags, drop guides that appear *between* and *beside* blocks, long-press drag on mobile web — is consistent with a custom pointer-event implementation, not native DnD (native previews can't be styled and touch can't initiate native drags). Treat that inference accordingly. What is documented is the UX: "Any content block in Notion (including lines of text) can be dragged and dropped around the page. As you drag, blue guides will appear to show you where it will go" ([Notion: Writing & editing basics](https://www.notion.com/help/writing-and-editing-basics)).

#### 3.2 Drop indicators and the drop-target model

The drop position model for a block editor needs more than "before/after": a drop can land **before** a block, **after** it, **inside** it (nesting, e.g. into a toggle or below-and-indented), or **beside** it (creating/joining a column). Notion communicates all four with the blue guide: horizontal line above/below, indented line for nesting, and a *vertical* line at the left/right edge of a block for column creation — "drag and drop… into the column next to your text" ([Notion help](https://www.notion.com/help/writing-and-editing-basics)). Atlassian's design guidance standardizes the indicator itself: "The drop indicator line is used to communicate relative placement," 2px line in the selection color with a terminal dot ([Pragmatic DnD design guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines)). ProseMirror ships this as the `dropcursor` plugin, with a per-node `disableDropCursor` opt-out ([prosemirror-dropcursor](https://github.com/ProseMirror/prosemirror-dropcursor)).

Hit-testing detail that matters: the drop target should be computed from the *pointer position relative to block bounding boxes* (closest block edge, with hysteresis and an x-threshold that switches between "after block" and "into column right of block"), not from DOM event targets — children, margins, and gaps between blocks otherwise create dead zones.

#### 3.3 Dragging multiple selected blocks

BlockNote's implementation is instructive: if the dragged block is inside the current selection and the selection spans several blocks, it swaps the selection to a custom `MultipleNodeSelection` (a Selection subclass spanning sibling nodes at one nesting level, "currently only used to allow users to drag multiple blocks at the same time"), builds the drag image by cloning the parent DOM node and deleting unselected children, and serializes the whole slice ([MultipleNodeSelection.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/MultipleNodeSelection.ts), [dragging.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/dragging.ts)). It also strips `iframe/embed/object` from the preview because embedded documents "can prevent the drag from initiating at all." Notion selects the hovered block automatically (or keeps the multi-selection) and drags all selected blocks as a unit.

#### 3.4 Columns by dropping side-by-side

In Notion, columns are not a property — they are structure: a `column_list` block containing `column` blocks, created implicitly when you drop a block at the left/right edge of another, and dissolved when the last sibling leaves. This follows from Notion's "everything is a block; indentation manipulates parent/content relationships, not styles" model ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)). Implication for the schema: column layout must be expressible as ordinary nested blocks so drag-drop, undo, copy, and Markdown export all treat it uniformly (export degrades columns to sequential blocks).

### 4. Selection

#### 4.1 The dual model

A block editor has two selection regimes and needs both as explicit, serializable state:

1. **Text selection** — anchor/head inside (or across) block text content.
2. **Block selection** — a set/range of whole blocks, no text caret.

The reason a raw DOM Selection can't be the source of truth is a decade old: many DOM trees render identically, browsers normalize carets inconsistently, and "two ContentEditable elements behave totally differently even though they look the same" ([Why ContentEditable is Terrible — Medium Engineering](https://medium.engineering/why-contenteditable-is-terrible-122d8a40e480)). Every serious editor models selection itself and *projects* it onto the DOM: ProseMirror has `TextSelection`, `NodeSelection`, `AllSelection`, plus `GapCursor` for positions where no text exists (before a leaf block such as an image or an hr) ([prosemirror-gapcursor](https://github.com/ProseMirror/prosemirror-gapcursor)); Lexical has `RangeSelection`, `NodeSelection`, `TableSelection`, all living in the EditorState ([Lexical: Selection](https://lexical.dev/docs/concepts/selection), [deep dive — jkrsp](https://jkrsp.com/blog/understanding-selections-in-lexical-js/)); BlockNote adds `MultipleNodeSelection` because PM's NodeSelection covers only one node.

#### 4.2 Notion's block-select mode (the UX contract to copy)

From Notion's documented shortcuts ([Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts), [Writing & editing basics](https://www.notion.com/help/writing-and-editing-basics)):

- `Esc` — select the block the caret is in (or clear an existing block selection). `Enter` — re-enter the selected block for text editing.
- Arrow keys — move the block selection to a neighboring block; `Shift+↑/↓` — extend the selection block-by-block.
- `Shift+Click` — select range of blocks between anchor and click; `Cmd/Alt+Shift+Click` — toggle individual blocks in/out of the selection.
- Click-drag starting in the page margin (outside text) rubber-band selects whole blocks.
- Once in block-selection mode, typing replaces, Backspace deletes blocks, Cmd+D duplicates, drag moves the whole set.

#### 4.3 Cross-block text selection and caret motion

Cross-block *text* selection (start mid-paragraph, end mid-list-item) is the hardest variant — Notion rebuilt its editor around it in 2022 and still couldn't ship it on Firefox at launch ([release notes](https://www.notion.com/releases/2022-01-19)). ProseMirror supports it natively because the whole document is one contenteditable and slices have "open" depths on both ends (the `data-pm-slice` open-start/open-end machinery exists precisely for copying such selections). Editors that render each block as an isolated contenteditable (early Notion, Editor.js) get clean per-block behavior but must fake cross-block selection with overlays — this is the single strongest argument for one contiguous editable region per page in our renderer, or for budgeting significant work on a custom selection layer.

Arrow-key navigation across block boundaries must be owned by the editor, not the browser: moving down from the last line of a paragraph into a table/image/toggle, skipping non-text blocks sensibly, and placing a GapCursor where there is no text position. PM's changelog is a catalog of edge cases here (gap cursor after tables, "selectable content skipped when moving selection with arrow keys" fixes) — treat boundary motion as a first-class command with tests per block type.

#### 4.4 Enter/Backspace split-merge semantics

ProseMirror's base commands define the canonical semantics ([prosemirror-commands reference](https://prosemirror.net/docs/ref/#commands)):

- **Enter** = chain: `newlineInCode` → `createParagraphNear` → `liftEmptyBlock` (empty list item/quote child lifts out one level instead of splitting) → `splitBlock` (split parent block at caret; a text selection is deleted first).
- **Backspace** = chain: `deleteSelection` → `joinBackward` (at start of a textblock: join with the previous block if compatible, *else lift the block closer to it structurally*) → `selectNodeBackward` (if the schema forbids joining, fall back to selecting the previous node — this is how pressing Backspace before an image selects it instead of deleting text).

Block-editor conventions layered on top (Notion, BlockNote): Enter at the end of a heading creates a paragraph (not another heading); Backspace at the start of a styled empty block first converts it to a paragraph, then merges; Backspace merging a list item into a paragraph strips the list wrapper. These are schema-aware *commands with fallback chains*, and every block type must declare how it splits and joins.

### 5. Accessibility

#### 5.1 contenteditable and screen readers

Screen readers don't reliably announce bare contenteditable regions as editable; historical testing found JAWS/NVDA unable to even read some regions ([Drupal/Aloha issue](https://www.drupal.org/project/aloha/issues/1747930)). Baseline mitigations ([10 tips for accessible rich text editors — jkrsp](https://jkrsp.com/accessibility-for-rich-text-editors/)): `role="textbox"` + `aria-multiline="true"` on the editable root; never trap keys screen-reader users depend on (Tab, arrows) without an escape hatch; every toolbar/handle button keyboard-reachable with `aria-label`; announce state changes (block moved, block type changed) via a polite live region; alt-text editing UI for images. Meta built Lexical partly because bolting a11y onto existing editors failed — its EditorState-first design keeps the DOM predictable for AT.

The **EditContext API** (decouples text-input/IME from DOM structure, letting an editor receive composition events without contenteditable's DOM mutations) is Chromium-only as of 2026; Mozilla's position is positive-with-concerns, WebKit's unknown; a polyfill exists ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API), [caniuse](https://caniuse.com/mdn-api_editcontext), [polyfill](https://github.com/neftaly/editcontext-polyfill)). Not a foundation yet; design input handling so it could slot in.

The extreme counter-model: Google Docs renders to `<canvas>` and maintains AT support through dedicated integration rather than the DOM — announced with explicit warnings to extension authors, and criticized because it forfeits the "semantic underlay" the DOM provides ([Google Workspace announcement](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html), [WebAIM](https://webaim.org/blog/seismic-change-to-docs/)). Not our path, but it clarifies what the DOM buys us for free.

#### 5.2 What the Gutenberg audits found

Tenon's 2019 audit (329-page technical report + user testing with people with disabilities, commissioned by WPCampus) is the most complete public a11y study of a block editor: markup "clean, semantically correct and accessible," yet "Gutenberg's user experience is consistently poor," with failures against 30 WCAG 2.1 success criteria — the flaws were *interaction design*, not markup ([WPTavern summary](https://wptavern.com/wpcampus-gutenberg-accessibility-audit-finds-significant-and-pervasive-accessibility-problems), [WPCampus audit hub](https://wpcampus.org/learning/audit/), [Tenon executive summary PDF](https://documents.wpcampus.org/gutenberg/audit/Gutenberg_Executive_Summary.pdf)). Specific gaps: block UIs that couldn't express needed semantics (no captions/header-cells UI on tables, no captions file on video). 84 GitHub issues were filed from it; 54 were resolved within months.

The structural fix that stuck, Gutenberg 6.3's **two-mode keyboard model**: the editor loads in *Navigation mode* — "move from block to block using a single Tab press… also use the arrow keys" — and `Enter` enters *Edit mode* inside the block, `Escape` returns to Navigation ([WPTavern on 6.3](https://wptavern.com/gutenberg-6-3-improves-accessibility-with-new-navigation-and-edit-modes)). This is the same Esc/Enter duality as Notion's block-selection mode — accessibility and power-user UX converge on one design. It also solves the tab-stop explosion: a document with 200 blocks must not be 200+ tab stops.

For drag interactions, Atlassian's guidance is the standard: "All draggable items should also have the ability to achieve the same outcomes using assistive technology friendly controls" — i.e., every drag-handle is also a button opening a menu with Move up/down/into, and keyboard move shortcuts (Notion: `Cmd/Ctrl+Shift+↑/↓`) exist for everything dragging can do ([Pragmatic DnD design guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines)).

### 6. Performance on long documents

**The conflict**: classic virtualization (windowing) unmounts off-screen DOM. That breaks browser find-in-page (Ctrl+F only finds mounted text), the accessibility tree (SR document navigation sees a hole), text selection across the window boundary, and URL/text-fragment anchors. 

**The 2026-era answer is CSS `content-visibility: auto`**: off-screen elements skip layout and paint, but "skipped contents must still be available to user-agent features such as find-in-page and tab order navigation… and must be focusable and selectable as normal" ([content-visibility explainer](https://github.com/WICG/display-locking/blob/main/explainers/content-visibility.md), [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)). Nolan Lawson's case study (emoji picker, ~20k nodes) went from ~3s to ~1.3s initial render (~45% improvement in Chrome and Firefox) with it — while noting the honest ceiling: retained DOM "fundamentally cannot match virtualized list performance" at 100k+ items, `contain-intrinsic-size` estimates matter (wrong estimates cause scrollbar jumping), and he hit a surprise Chromium cost from `<img loading=lazy>` unrelated to containment ([Read the Tea Leaves](https://nolanlawson.com/2024/09/18/improving-rendering-performance-with-css-content-visibility/)). Blocks are the natural `content-visibility` unit: apply it per top-level block with a stored height estimate (we know last-rendered heights).

**What the big editors do**: CodeMirror renders only the viewport and reimplements search in-editor (accepting that Ctrl+F must be intercepted) — the honest cost of true virtualization. Google Docs went all the way to canvas for rendering performance and consistency ([announcement](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html)). Notion's big wins were *not* render virtualization but data-layer: caching record data in WASM SQLite (via OPFS, SharedWorker) cut page-navigation times 20% globally, 28–33% in high-latency regions — with the instructive sub-lesson that the first rollout *hurt* load times because the few-hundred-KB WASM download blocked page load, fixed by making it fully async and non-blocking ([How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)).

Practical thresholds seen across sources: documents under a few thousand blocks are fine with plain DOM + `content-visibility`; genuine windowing is only warranted for unbounded lists (database views!) where find-in-page semantics are already app-owned. If Ctrl+F must work over unmounted content, you must intercept Cmd/Ctrl+F and ship your own search UI — a large, user-visible cost; defer it.

## Pitfalls

1. **Undo as whole-state rollback.** Snapshot-only undo cannot coexist with collaboration (it would revert other users' work) and makes selective undo impossible. ProseMirror's selective, rebased inverse-step design exists "because it is necessary for collaborative editing" — adopting a simpler model now creates a rewrite later.
2. **Coalescing by timer alone.** Merging everything within N ms produces undo steps that swallow a block split or a paste. Lexical's rule set (merge only forward-typing/backspace/delete; break on selection moves, focus loss, IME composition, structural ops, paste) is the tested policy.
3. **Undo entries without selection bookmarks.** Undo that restores content but leaves the caret at the wrong place (or nowhere) reads as broken; positions must be stored mapping-safe (prosemirror-history maps bookmarks through later changes).
4. **A custom clipboard MIME type as the only rich format.** Custom types don't survive the OS clipboard portably (async API allows 3 types; `"web "` custom formats are Chromium-only). Figma/ProseMirror smuggle fidelity inside `text/html` attributes precisely for this reason. Also never write *only* rich formats — always a decent `text/plain`.
5. **Trusting pasted HTML — or sanitizing it with regexes.** `img onload`, `javascript:` URLs, and obfuscated markup have produced real editor CVEs (Joplin). Parse into the schema (whitelist by construction); DOMPurify anything that must remain raw HTML.
6. **Interpreting Google Docs' `<b>` wrapper as bold, or Word's `mso-` lists as paragraphs.** Without source-sniffing (`docs-internal-guid`, `Mso*`) and per-source normalizers, pasted documents arrive visually mangled and full of junk spans that then get *saved into the document*.
7. **Choosing HTML5 DnD for the primary block-drag UX.** No touch initiation, unstylable static previews, no `getData` during dragover, unreliable auto-scroll. Native DnD is the right tool for *external* interop (file drop, cross-window), not for Notion-grade internal block moves — BlockNote's issue tracker (drag preview customization requests) shows the ceiling being hit.
8. **Computing drop targets from DOM event targets instead of geometry.** Margins, gaps and nested wrappers create dead zones and flickering indicators; use pointer coordinates vs block rects with hysteresis, and make "before/after vs nest vs column" an explicit edge model.
9. **One contenteditable per block.** It simplifies each block but makes cross-block text selection, copy of partial ranges, and caret motion across boundaries nearly impossible to get right — Notion spent a full editor rewrite (2022) un-doing this class of limitation and still had a Firefox gap. (Corollary: don't let the browser own Enter/Backspace either — every such key is a schema command.)
10. **Every block a tab stop; drag as the only way to move blocks.** The Tenon audit's core finding was interaction design, not markup: without a Navigation/Edit mode split, keyboard and SR users drown in tab stops; without menu/shortcut equivalents for drag, reordering is inaccessible (WCAG 2.1 failures across 30 criteria).
11. **Virtualizing the document as a default.** Windowing silently breaks Ctrl+F, SR navigation, selection, and anchors. Reach for `content-visibility: auto` + height estimates first; virtualize only unbounded database views. And if you ever load a WASM/data layer, load it async — Notion measurably regressed page load by blocking on it.
12. **Ignoring Firefox and IME until late.** Notion shipped cross-block selection without Firefox; WebKit rewrites spaces to `&nbsp;` on copy; IME composition must never be interrupted by history grouping or re-renders. These are launch-blocking classes of bugs that only surface in cross-browser/IME testing.

## Recommendations for our editor

1. **Undo = inverse operations over the schema, not the DOM and not snapshots.** We already plan an intermediate document schema and (later) p2p sync; make every edit an operation with a defined `invert()`, batched into transactions (Notion's exact shape). History stores `{inverseOps, selectionBefore (block-id + offset addressed), groupId}`. This gives selective undo, collab-compatibility (`addToHistory:false` equivalent for remote transactions), and a free audit/sync log. When sync arrives, scope undo to local-origin transactions (Yjs `trackedOrigins` semantics).
2. **Coalescing policy**: merge adjacent text-insert/backspace/delete ops within 500ms into the open group; hard-break on: block structure ops, selection moves, focus loss, paste, IME composition end, and an explicit `closeHistoryGroup()` API. Expose `undoDepth/redoDepth` for UI.
3. **Clipboard writes three formats** via `ClipboardEvent.clipboardData` (portable path): `text/html` — clean semantic HTML with one wrapper attribute (e.g. `data-<ourname>-doc` = base64 JSON of the schema slice + open-depth/context info, PM/Figma style); `text/plain` — Markdown (BlockNote precedent; it makes us a good citizen everywhere and matches our Markdown-readable storage principle); plus a custom type for cheap same-origin detection. **Paste reads in priority order**: internal attribute → `vscode-editor-data` → `text/markdown` → `text/html` (source-sniff Word/GDocs → normalize → parse into schema) → `text/plain` (Markdown heuristic with conservative thresholds) → `Files`. Ship `Cmd+Shift+V` paste-without-formatting from day one.
4. **Schema-as-sanitizer**: paste never injects HTML; it parses into whitelisted node/mark types and re-renders. DOMPurify only for raw-HTML embed blocks. Add a paste test corpus (Word, GDocs, Excel, VS Code, Notion, web pages) as fixtures early — this is the highest-regression-risk area of the whole editor.
5. **Drag & drop: pointer events for blocks, native DnD for files.** Drag handle uses pointer capture + `elementsFromPoint`; drag starts after a small movement threshold; preview is our own DOM (multi-block stack + count badge); Escape cancels; edge auto-scroll built in. Drop model is explicit: `{targetBlockId, edge: before|after|inside|left|right}` where `left/right` creates/joins a `columnList/column` structure (columns are ordinary nested blocks in the schema so undo/copy/export degrade gracefully). Keep `dragenter/drop` listeners for OS file drops and consider native DnD *additionally* for drag-out interop later.
6. **Selection is core state with two variants**: `TextSelection {anchor, head}` (block-id + offset addressed, cross-block capable) and `BlockSelection {anchorBlockId, headBlockId | Set<id>}`, plus a GapCursor equivalent for leaf blocks. One contiguous editable region per page. Notion's key contract verbatim: Esc ↔ Enter to switch levels, arrows/Shift+arrows in block mode, Shift+Click range, Cmd/Alt+Shift+Click toggle, margin rubber-band select, Cmd/Ctrl+Shift+↑/↓ moves blocks. Enter/Backspace implemented as per-block-type split/join command chains (PM's `liftEmptyBlock`/`joinBackward`/`selectNodeBackward` chain is the reference semantics).
7. **Accessibility is an architecture line-item, not a pass at the end**: `role="textbox"` + `aria-multiline` on the page; Navigation/Edit keyboard modes (which we get almost free — they're the same state machine as block selection); a single tab stop for the document; drag handle doubles as a menu button whose menu can do everything drag can; polite live-region announcements for block move/type changes; alt-text UI on images; NVDA + VoiceOver smoke tests in CI checklists. Track EditContext for the input layer but build on beforeinput/contenteditable today, behind an input-adapter interface.
8. **Performance plan**: per-block `content-visibility: auto` with `contain-intrinsic-size` from cached measured heights; no document virtualization (protects Ctrl+F, a11y tree, selection). Virtualize only database views (app-owned search semantics there anyway). Keep the data layer off the critical path (async, never block first paint — Notion's WASM SQLite lesson). Budget: 10k-block page must scroll at 60fps before we consider anything more exotic.

## Sources

- [ProseMirror Guide (transforms, history)](https://prosemirror.net/docs/guide/)
- [ProseMirror Reference — prosemirror-history](https://prosemirror.net/docs/ref/#history)
- [ProseMirror Reference — prosemirror-commands](https://prosemirror.net/docs/ref/#commands)
- [prosemirror-history source (selection bookmarks, selective undo)](https://code.haverbeke.berlin/prosemirror/prosemirror-history)
- [prosemirror-view clipboard.ts (data-pm-slice, WebKit nbsp workaround)](https://github.com/ProseMirror/prosemirror-view/blob/master/src/clipboard.ts)
- [prosemirror-dropcursor](https://github.com/ProseMirror/prosemirror-dropcursor)
- [prosemirror-gapcursor](https://github.com/ProseMirror/prosemirror-gapcursor)
- [Lexical — History concepts (coalescing rules, delay)](https://lexical.dev/docs/concepts/history)
- [Lexical — Editor State](https://lexical.dev/docs/concepts/editor-state)
- [Lexical — Selection concepts](https://lexical.dev/docs/concepts/selection)
- [Understanding Lexical Selections — jkrsp](https://jkrsp.com/blog/understanding-selections-in-lexical-js/)
- [The data model behind Notion's flexibility — Notion blog](https://www.notion.com/blog/data-model-behind-notion)
- [Notion release notes 2022-01-19 — cross-block text selection](https://www.notion.com/releases/2022-01-19)
- [Notion Help — Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)
- [Notion Help — Writing & editing basics (drag guides, columns)](https://www.notion.com/help/writing-and-editing-basics)
- [How we sped up Notion in the browser with WASM SQLite — Notion blog](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- [How to undo in Notion — super.so](https://super.so/blog/how-to-undo-in-notion-across-devices)
- [Y.UndoManager — Yjs docs](https://docs.yjs.dev/api/undo-manager)
- [Yjs issue #273 — undo blocked by other-origin changes](https://github.com/yjs/yjs/issues/273)
- [BlockNote dragging.ts (HTML5 DnD, drag image, 3 clipboard formats)](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/dragging.ts)
- [BlockNote MultipleNodeSelection.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/extensions/SideMenu/MultipleNodeSelection.ts)
- [BlockNote acceptedMIMETypes.ts (paste priority)](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/api/clipboard/fromClipboard/acceptedMIMETypes.ts)
- [BlockNote copyExtension.ts](https://github.com/TypeCellOS/BlockNote/blob/main/packages/core/src/api/clipboard/toClipboard/copyExtension.ts)
- [The web's clipboard, and how it stores data of different types — Alex Harri](https://alexharri.com/blog/clipboard)
- [Web custom formats for the Async Clipboard API — Chrome](https://developer.chrome.com/blog/web-custom-formats-for-the-async-clipboard-api/)
- [Unsanitized HTML in the Async Clipboard API — Chrome](https://developer.chrome.com/docs/web-platform/unsanitized-html-async-clipboard)
- [How to clean HTML pasted from Word and Google Docs — Unwrite](https://unwrite.co/blog/clean-html-pasted-from-word-google-docs/)
- [Paste from Google Docs — CKEditor 5 docs](https://ckeditor.com/docs/ckeditor5/latest/features/pasting/paste-from-google-docs.html)
- [Tiptap Markdown examples (looksLikeMarkdown paste heuristic)](https://tiptap.dev/docs/editor/markdown/examples)
- [Tiptap Paste rules](https://tiptap.dev/docs/editor/api/paste-rules)
- [Parse Markdown pasted into the Content Editor — GitLab](https://gitlab.com/gitlab-org/gitlab/-/issues/337145)
- [Joplin advisory GHSA-m59c-9rrj-c399 (paste XSS)](https://github.com/laurent22/joplin/security/advisories/GHSA-m59c-9rrj-c399)
- [How does DOMPurify ensure sanitized HTML is safe](https://dompurify.com/how-does-dompurify-ensure-that-sanitized-html-is-safe-for-injection-into-the-dom/)
- [HTML5 Drag & Drop — Not the API You're Looking For — sam.today](https://www.sam.today/blog/html5-dnd-the-api-that-is-gaslighting-you)
- [Common Pitfalls with the HTML5 Drag'n'Drop API — Alexander Adam](https://medium.com/@reiberdatschi/common-pitfalls-with-html5-drag-n-drop-api-9f011a09ee6c)
- [Designed for delight, built for performance (Pragmatic DnD) — Atlassian](https://www.atlassian.com/blog/design/designed-for-delight-built-for-performance)
- [Pragmatic drag and drop — design guidelines — Atlassian](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines)
- [Pragmatic drag and drop — web platform design constraints — Atlassian](https://atlassian.design/components/pragmatic-drag-and-drop/web-platform-design-constraints/)
- [@atlaskit/pragmatic-drag-and-drop-auto-scroll](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop-auto-scroll)
- [Why ContentEditable is Terrible — Nick Santos, Medium Engineering](https://medium.engineering/why-contenteditable-is-terrible-122d8a40e480)
- [10 tips for building accessible rich text editors — jkrsp](https://jkrsp.com/accessibility-for-rich-text-editors/)
- [contenteditable is not accessible to screen readers — Drupal/Aloha issue](https://www.drupal.org/project/aloha/issues/1747930)
- [WPCampus Gutenberg Accessibility Audit results](https://wpcampus.org/blog/2019/05/gutenberg-audit-results/)
- [Gutenberg Accessibility Audit — Tenon executive summary (PDF)](https://documents.wpcampus.org/gutenberg/audit/Gutenberg_Executive_Summary.pdf)
- [WPCampus audit finds "significant and pervasive accessibility problems" — WPTavern](https://wptavern.com/wpcampus-gutenberg-accessibility-audit-finds-significant-and-pervasive-accessibility-problems)
- [Gutenberg 6.3 Navigation and Edit modes — WPTavern](https://wptavern.com/gutenberg-6-3-improves-accessibility-with-new-navigation-and-edit-modes)
- [EditContext API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API)
- [EditContext API support — caniuse](https://caniuse.com/mdn-api_editcontext)
- [EditContext polyfill](https://github.com/neftaly/editcontext-polyfill)
- [content-visibility explainer — WICG display-locking](https://github.com/WICG/display-locking/blob/main/explainers/content-visibility.md)
- [content-visibility — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)
- [Improving rendering performance with CSS content-visibility — Nolan Lawson](https://nolanlawson.com/2024/09/18/improving-rendering-performance-with-css-content-visibility/)
- [Google Docs canvas-based rendering announcement — Google Workspace Updates](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html)
- [Google Announces Seismic Change to Docs — WebAIM](https://webaim.org/blog/seismic-change-to-docs/)
