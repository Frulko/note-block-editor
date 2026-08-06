# Architecture Lessons from ProseMirror, Lexical, and Slate

Research note for the design of a from-scratch, vanilla-TypeScript, Notion-style **block** editor (headless core + thin framework bindings). Researched August 2026; all claims verified against sources listed at the bottom.

## TL;DR

- **ProseMirror's core insight is the strongest and most transferable**: model the document as an immutable value, express every change as a small, invertible, serializable *step*, and derive everything else (undo, collab, position mapping, plugin reactions) from the step trail. Its collab model is "git with automatic rebase" over a central authority — not OT, not CRDT.
- **ProseMirror's biggest cost is its global integer position system**: every position in the whole doc is one integer in a token stream, so *every* feature (selection, decorations, plugins, collab) must constantly map positions through changes. This is precisely the complexity a block editor can amputate: block identity comes from **stable block IDs**, and positions reduce to `(blockId, offset-within-block)`.
- **Lexical's EditorState is a flat `Map<NodeKey, LexicalNode>`** — not a nested tree — with parent/sibling links stored as keys. Double-buffering (frozen "current" state + mutable "pending" state built inside `editor.update()`) plus a dirty-node set gives it cheap snapshots, O(changed-nodes) DOM reconciliation, and snapshot-based undo. This flat-map-of-nodes-by-ID shape is almost exactly a Notion block table and is the right in-memory shape for us.
- **Lexical exists because Draft.js failed**: ImmutableJS overhead, hard React coupling (React rendered the editor DOM), and an architecture that "quickly fell apart" beyond simple cases. Meta archived Draft.js in 2022 and replaced it internally. Lesson: never let a UI framework own the editable DOM, and never let a heavyweight data library be the document.
- **Lexical's own weakness is ecosystem, not core**: the core genuinely runs in vanilla JS, but plugins, docs and tooling grew React-first for years (the framework-independent "Extensions" system only arrived recently), it is still 0.x in August 2026 (v0.49.0), and it lacks ProseMirror-style declarative decorations.
- **Slate is the cautionary tale**: schema-less core + multi-pass `normalizeNode` normalization (with real leaky/infinite-loop failure modes), a decade in "beta" with breaking minor releases including a total 0.50 rewrite, and recurring large-document performance issues (10k-line paste: ~7s in Slate vs ~1s in Tiptap). Its good ideas — plain-JSON document, interface-based typing, commands-vs-transforms split — are worth stealing.
- **Blocks change the complexity budget**: with blocks as the unit (Notion's model: `id`, `type`, `properties`, `content: childIds[]`, `parent`), structural edits become list operations on ID arrays (insert/move/remove/update — trivially invertible, easy to sync), and rich-text complexity is quarantined *inside* single text blocks where documents are tiny.
- **Skip from ProseMirror**: global token positions and position mapping across the doc, regex-like content expressions over one big tree, cross-block ReplaceAroundStep-style surgery, tree-wide normalization. **Keep**: schema-driven per-block validation, invertible-op transactions, plugin state reduced from transactions, decoration-style overlays kept out of the document.
- **Command dispatch (Lexical) + transaction building (ProseMirror) compose well**: commands express *intent* and are interceptable/prioritized; transactions express *what changed* and are the unit of undo, persistence and sync. Keep both layers, keep them separate (Slate 0.50 reached the same conclusion: commands = intent, transforms = change).

---

## Findings

### 1. ProseMirror

#### 1.1 Design rationale: distrust contentEditable, own the model

Marijn Haverbeke's founding essay is explicit that raw contentEditable gives "very little control over what the user and the browser are doing to our document", so ProseMirror keeps contentEditable only as an input/rendering surface: it "gives us all the logic related to focus and cursor motion for free, and makes it much, much easier to support screen readers and bidirectional text", while all *mutations* are captured as events and converted into operations on an internal document ([ProseMirror announcement, marijnhaverbeke.nl](https://marijnhaverbeke.nl/blog/prosemirror.html)).

The document is "explicitly not HTML" but "a tree-shaped data structure that describes the structure of the text in terms of paragraphs, headings, lists, emphasis, links". The payoff of a constrained model: "If the document is only modified by your code, you can define these modifications so that they preserve the invariants you want to preserve." ([ibid.](https://marijnhaverbeke.nl/blog/prosemirror.html))

#### 1.2 Document model: immutable persistent tree; flat inline content with marks

- Documents are **immutable values with structural sharing**: "Nodes are simply *values*, and should be approached much as you'd approach the value representing the number 3." Updating produces a new document that shares unchanged sub-nodes, which makes updates cheap and enables "a very fast document-diffing algorithm to make only the DOM updates that are actually necessary" ([ProseMirror Guide](https://prosemirror.net/docs/guide/), [announcement](https://marijnhaverbeke.nl/blog/prosemirror.html)).
- **Inline content is a flat sequence, not a tree.** Bold/italic/link are *marks* (sets of metadata on text runs), not nested elements. "Adjacent text nodes with the same set of marks are always combined together, and empty text nodes are not allowed." The stated reason: "It allows us to represent positions in a paragraph using a character offset rather than a path in a tree" — flat inline content deliberately trades DOM-likeness for positional simplicity ([Guide](https://prosemirror.net/docs/guide/)). This marks-on-flat-text model is now near-universal (Lexical stores format bitflags on TextNodes; Notion stores styled runs in block properties).
- Node-specific data (heading level, image src) lives in **attributes**.

#### 1.3 Schema and content expressions

Every document conforms to a schema that "describes the kind of nodes that may occur in the document, and the way they are nested". Child sequences are constrained by regex-like **content expressions** — `"paragraph+"`, `"(paragraph | blockquote)+"`, `"heading block*"` — and nodes can join named **groups** (`group: "block"`) referenced from other expressions. Order matters inside or-expressions: the first matching type is used when synthesizing default content ([Guide](https://prosemirror.net/docs/guide/), [schema example](https://prosemirror.net/examples/schema/)).

Two consequences worth noting:

1. The schema lets the *transform layer* be schema-aware: operations like split/join/wrap consult the schema to know what is legal, so invalid documents are unrepresentable rather than repaired after the fact (the anti-Slate approach — see §3.3).
2. The full regex machinery (NFA over child sequences, content matching for finding valid wrap/split points) is a significant chunk of ProseMirror's complexity — and it exists because *one* grammar must govern arbitrary nesting across the entire document.

#### 1.4 Positions: one integer per token, resolved on demand

Any document position is a single integer index into a token sequence: entering or leaving a non-leaf node costs 1 token, each character costs 1, each leaf node costs 1. `doc.resolve(pos)` produces a `ResolvedPos` with the parent node, offset, and ancestor path ([Guide](https://prosemirror.net/docs/guide/)).

This design is elegant (a selection is just two integers; any range is `[from, to]`) but it has a systemic cost: **an integer position is only meaningful relative to one specific document value**. Every edit invalidates every held position. Hence:

#### 1.5 Steps, transactions, and position mapping

- Changes are decomposed into **steps** (`ReplaceStep`, `AddMarkStep`, …) — small, serializable, invertible descriptions of a single modification. "The transform system... leave[s] a *trail* of updates, in the form of values that represent the individual steps taken to go from an old version of the document to a new one" — this trail is what powers undo and collab ([Guide](https://prosemirror.net/docs/guide/), [prosemirror-transform README](https://github.com/ProseMirror/prosemirror-transform/blob/master/src/README.md)).
- A **Transaction** (subclass of Transform, part of EditorState) bundles steps plus selection update, stored marks, and arbitrary **metadata** (`tr.setMeta`/`getMeta`) used by plugins to tag transactions (e.g. "this came from collab, don't add to history").
- Every step yields a **StepMap**; sequences compose into a **Mapping**. Anything holding a position (selection, decorations, plugin state, pending collab steps) must map it forward: `map(pos, bias)` with bias −1/+1 controlling which side to stick to when content is inserted exactly at the position ([Guide](https://prosemirror.net/docs/guide/)). Mapping through deletions loses information; "mirror map" bookkeeping exists to recover positions when a delete is undone by a corresponding insert during rebasing ([Collaborative Editing in ProseMirror](https://marijnhaverbeke.nl/blog/collaborative-editing.html)).

This machinery is powerful and is also the number-one thing users struggle with (see §1.8).

#### 1.6 Plugins, plugin state, decorations

- Plugins are values registered on EditorState. A plugin can own a **state slot** with `init`/`apply(tr, oldValue) → newValue` — i.e., plugin state is a *reducer over transactions*, and "Plugin state values must be immutable" ([Guide](https://prosemirror.net/docs/guide/)). This is a genuinely great pattern: all state, core and plugin, advances through the same transaction pipeline, so time-travel/undo/collab see one consistent world.
- Plugins also contribute **props** to the view (event handlers, decorations), with deterministic precedence ordering.
- **Decorations** draw things that are not in the document: node decorations (add attrs/classes to a node's DOM), widget decorations (insert DOM at a position), inline decorations (style a range). They live in a `DecorationSet` "which is a data structure that mimics the tree shape of the actual document" for efficient diffing, and the recommended pattern is to keep the set in plugin state and **map it forward** through transactions rather than recompute ([Guide](https://prosemirror.net/docs/guide/)). Decorations are how you do search highlights, collab cursors, comment ranges, placeholder hints — without polluting the persisted document.

#### 1.7 Why ProseMirror is collab-ready: rebaseable steps, central authority

Marijn's collab essay rejects classical OT ("implementing OT sucks. There's a million algorithms with different trade-offs, mostly trapped in academic papers") and full decentralization: "The design decisions that make the OT mechanism complex largely stem from the need to have it be truly distributed." Instead ([Collaborative Editing in ProseMirror](https://marijnhaverbeke.nl/blog/collaborative-editing.html), [Guide](https://prosemirror.net/docs/guide/)):

- A **central authority** assigns a total order to changes. Clients optimistically apply local steps, then try to push; if the server has moved on, the client pulls the new steps, **rebases** its unconfirmed steps over them (invert → map through remote maps → re-apply), and retries. Explicitly modeled on git push/pull/rebase, minus manual conflict resolution.
- Steps being **invertible** also gives collab-safe undo: prosemirror-history stores inverted steps and *maps them* through subsequent (including remote) changes, so undo undoes *your* change even after others have edited elsewhere.
- Tradeoffs, stated candidly: it is centralized; and rebasing can silently drop a change whose context vanished — "unsuitable for branching workflows where git-style conflict resolution would be necessary", and long-offline editing is not the sweet spot. (For p2p/offline-first we will need CRDT-style ordering for block lists — but note that step-based ProseMirror is what Yjs, y-prosemirror and most production collab editors bind to; the step model doesn't preclude a CRDT transport underneath.)

#### 1.8 Criticisms: the learning curve is real and specific

- Community verdict, verbatim: "I really like the API of Prosemirror, complex things are made very simple. But unfortunately very basic stuff is extremely hard to get done in prosemirror !!" ([discuss.prosemirror.net](https://discuss.prosemirror.net/t/prosemirror-is-very-hard-on-basic-stuff-like-suggestions/2995)). A developer reported "2-3 weeks getting all of the formatting, tooltips and key mappings" for basic bold/italic/lists ([HN](https://news.ycombinator.com/item?id=16825034)).
- The 2025 Liveblocks survey: "Setting up a full editor 'from scratch', using only the core libraries, requires quite a lot of code"; recommended path is a wrapper (Tiptap, BlockNote, Remirror) ([Liveblocks 2025 comparison](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)). The existence of a whole industry of ProseMirror wrappers is itself the criticism: the raw toolkit's abstraction level is below what app developers want.
- Root causes worth naming: (a) integer positions + mandatory mapping; (b) content-expression schema machinery; (c) "toolkit, not editor" philosophy — nothing works until many pieces are assembled; (d) documentation that explains concepts but not recipes.

### 2. Lexical

#### 2.1 Origin: Draft.js post-mortem

Draft.js (Facebook, 2016) made React render the editor content, used ImmutableJS for state, and modeled the doc as a flat list of blocks with entity ranges. Meta archived it in 2022: "Draft.js pulled in a lot of JavaScript that was hard to reason with... ImmutableJS didn't scale as desired", it had "compatibility issues with React 18+", and its block model "quickly fell apart when you wanted to do something more complex" ([facebookarchive/draft-js](https://github.com/facebookarchive/draft-js), [HN: replacing Draft.js with Lexical](https://news.ycombinator.com/item?id=31022152), [migration guide](https://dev.to/dragogargo/how-to-migrate-from-draftjs-to-lexical-in-2026-complete-guide-4960)). Lexical was open-sourced April 2022 as the internal replacement, with reliability/accessibility/performance as headline goals.

Key architectural corrections relative to Draft.js: Lexical owns its own DOM reconciler — "The core library is framework-agnostic, with its own diffing and reconciliation processes" (Lexical team member acywatson, [HN](https://news.ycombinator.com/item?id=31813550)) — and uses plain classes + a flat node map instead of ImmutableJS.

#### 2.2 EditorState: immutable snapshots via double-buffering over a flat node map

- An `EditorState` contains exactly two things: "The editor node tree (starting from the root node). The editor selection (which can be null)" — **selection is part of state**, not a DOM side-channel ([Editor State docs](https://lexical.dev/docs/concepts/editor-state)).
- The "tree" is physically a **flat map**: "The EditorState maintains a `Map<NodeKey, LexicalNode>` that tracks all nodes." Nodes reference parent/siblings/children by key (`__parent`, `__prev`, `__next`, `__first`, `__last`, `__size`), giving O(1) lookup by key ([Key Management docs](https://lexical.dev/docs/concepts/key-management)).
- **Double buffering**: "There are never more than two editor states in play" — a frozen "current" state (what's on screen) and a "pending" state built during `editor.update(() => {...})`; when reconciliation finishes they swap ([Lexical's Design](https://lexical.dev/docs/design), [Editor State docs](https://lexical.dev/docs/concepts/editor-state)). Inside an update, states "can be thought of as 'mutable'. After an update, the editor state is then locked and deemed immutable from there on."
- Copy-on-write at node granularity: `node.getWritable()` "creates a clone of the node if needed", `getLatest()` reads the freshest version from the pending state ([Nodes docs](https://lexical.dev/docs/concepts/nodes)). Mutated nodes are tracked as a **dirty set**, so both node transforms and the reconciler know exactly what changed.
- Updates batch: "Reconciling an update is typically an async process that allows Lexical to batch multiple synchronous updates of the editor state together in a single update to the DOM" ([Editor State docs](https://lexical.dev/docs/concepts/editor-state)).
- **NodeKeys are ephemeral**: "Keys are never serialized" and are regenerated on deserialization — they are runtime identity only, never document identity ([Key Management docs](https://lexical.dev/docs/concepts/key-management)). (For a persistent block editor we differ here deliberately: block IDs *are* document identity. See Recommendations.)

#### 2.3 Node system

Five base classes: `RootNode` (exactly one, represents the contenteditable itself, not extensible), `ElementNode` (containers, block or inline), `TextNode` (leaf text with format bitflags, token/segmented modes), `DecoratorNode` ("Wrapper node to insert arbitrary view (component) inside the editor. Decorator node rendering is framework-agnostic."), `LineBreakNode` (normalized `\n`) ([Nodes docs](https://lexical.dev/docs/concepts/nodes)).

Extension is **subclassing**: implement `static getType()`, `static clone()`, `importJSON`/`exportJSON`, `createDOM`/`updateDOM`. Since v0.33 a `$config` helper cuts the boilerplate. Notable mechanism: **node replacement** lets an app substitute a subclass for a built-in node type editor-wide (e.g. replace all `TextNode` with `CustomTextNode`) — a pragmatic answer to "how do I extend behavior of core types", though class-identity-based node registration has been a recurring source of friction (versioned duplicate registrations, subclass vs config debates).

#### 2.4 Commands, listeners, transforms

Three distinct reaction mechanisms, cleanly separated ([Lexical's Design](https://lexical.dev/docs/design), [Commands docs](https://lexical.dev/docs/concepts/commands)):

- **Commands** = intent dispatch. `createCommand()` makes a typed command; DOM events are translated centrally into commands (`KEY_TAB_COMMAND`, `FORMAT_TEXT_COMMAND`, …); `registerCommand(cmd, handler, priority)` registers interceptors; handlers run highest-priority-first and "Return true to stop propagation". This gives apps a single choke point to reinterpret *any* input (tab in a code block vs tab in a list) without touching core.
- **Node transforms** = normalization hooks that run *during* an update when nodes of a type are dirty, before reconciliation — "the efficient mechanism to respond to changes and make changes to the EditorState" (e.g. auto-linkify a TextNode matching a URL regex). Transforms run to fixpoint over dirty nodes only — Lexical's answer to Slate's whole-tree normalize loop.
- **Listeners** = post-commit observation (`registerUpdateListener`, `registerMutationListener` for per-node-type created/destroyed/updated) — for syncing external UI, persistence, analytics.

#### 2.5 The DOM reconciler and input handling

Lexical diffs current-vs-pending states and patches only what changed, skipping most diff work because the dirty set already names the mutated nodes ([Lexical's Design](https://lexical.dev/docs/design)). External DOM mutations (browser autocorrect, extensions, IME) are caught by a **MutationObserver** and either reverted or reinterpreted as state updates — the "defend the model against the browser" stance shared with ProseMirror. On Android/IME specifically, the team relies on `beforeinput`/`input` events plus MutationObserver pattern-detection rather than extra DOM markers (trueadm, [HN](https://news.ycombinator.com/item?id=31813550)); this thread also contains Notion engineer jitl's warning that editors ignoring Android/CJK composition (his example: Slate) are non-starters for global products.

#### 2.6 History: snapshots, not inverse operations

`@lexical/history` implements undo/redo as a stack of EditorState snapshots (cheap because states share structure) with **coalescing**: "Users generally expect that continuous typing should fully undo with a single undo gesture", and similar coalescing for continuous operations like image resizing ([@lexical/history](https://lexical.dev/docs/packages/lexical-history), [History docs](https://lexical.dev/docs/concepts/history)). Contrast with ProseMirror's inverted-steps history, which is more complex but stays correct under concurrent remote edits. Snapshot undo is simpler but is *whole-editor* undo; it cannot selectively undo your changes in a collab session (Lexical's Yjs binding swaps in Yjs's UndoManager for that).

#### 2.7 Tradeoffs and current state (August 2026)

- **Still 0.x**: current release v0.49.0 (Aug 2026), frequent releases, "Pre-1.0 status indicates ongoing maturation" ([npm](https://www.npmjs.com/package/lexical?activeTab=versions), [releases](https://github.com/facebook/lexical/releases), [Liveblocks](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)). Doctrine's evaluation: "Since the library is under development, the documentation is not complete and structural changes often happen" ([Doctrine on Medium](https://medium.com/doctrine/should-we-use-lexical-to-edit-our-legal-graph-61aa9cfab096)).
- **React-centric ecosystem despite framework-agnostic core**: core works in vanilla JS ([vanilla quick start](https://lexical.dev/docs/getting-started/quick-start), [issue #2313](https://github.com/facebook/lexical/issues/2313)), but for years the plugin ecosystem shipped as `@lexical/react` components, forcing vanilla users to reimplement (community fills gaps: [lexical-vanilla-plugins](https://github.com/jetrockets/lexical-vanilla-plugins), [JetRockets writeup](https://jetrockets.com/blog/want-to-use-lexical-without-react)). The new **Extensions** system is the correction: "Extensions are a convention to add configuration and behavior to a Lexical editor in a modular and framework-independent manner... Extensions work the same way with or without React" ([Extensions docs](https://lexical.dev/docs/extensions/intro)). Lesson: framework-agnosticism is decided by where the *plugins* live, not the core.
- **No declarative decorations**: Lexical "lacks pure decorations; requires DOM workarounds for advanced features" — highlight-style overlays (search results, comment anchors) need mark-nodes-in-document or manual DOM ([Liveblocks](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)). This is a widely felt gap versus ProseMirror.
- **Perf at extremes**: failed the "Moby Dick" giant-single-document test in 2022 (insertions were O(n) in early versions; since improved) ([HN](https://news.ycombinator.com/item?id=31813550)); Liveblocks still notes a "heavier core package than Tiptap and Slate".
- Yjs collab binding exists but "is a bit buggy without handling edge cases yourself" ([Liveblocks](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)).

### 3. Slate: the cautionary tale

#### 3.1 What Slate wanted to be

Slate's principles: first-class plugins, **schema-less core** ("minimal assumptions about data structure"), nested recursive document "parallel to the DOM", intuitive commands, collaboration-ready data model ([slate README](https://github.com/ianstormtaylor/slate)). The 0.50 rewrite (late 2019) added genuinely good ideas: plain JSON nodes ("The data model is now comprised of simple JSON objects" after dropping ImmutableJS), **interface-based** typing ("Slate only expects that the objects implement an interface" — custom props live directly on nodes), concept consolidation (Selection/Annotation/Decoration → `Range`; Block/Inline → `Element`), and a clean **commands (intent) vs transforms (mechanics)** split. The rewrite cut the codebase ~53%, from 13,807 to 6,468 lines ([Migrating docs](https://docs.slatejs.org/concepts/xx-migrating)).

#### 3.2 Perpetual instability

- The README *still* says: "Slate is currently in beta... you might need to pull request improvements for advanced use cases" and "Some of its APIs are not 'finalized' and will have breaking changes over time" — a decade after launch, with no scheduled 1.0 ([README](https://github.com/ianstormtaylor/slate)).
- Pre-1.0 policy: "breaking changes will be added as minor version bumps" ([Changelog](https://docs.slatejs.org/general/changelog)) — every upgrade is a potential migration, including changes to operation shapes that break anyone doing OT/persistence at the operation level.
- The 0.50 rewrite was a **total rewrite**; migration "was not a simple task" ([issue #3215](https://github.com/ianstormtaylor/slate/issues/3215), [Migrating docs](https://docs.slatejs.org/concepts/xx-migrating)). Ecosystem plugins died at the boundary.
- Contributor-driven with no company backing ([README](https://github.com/ianstormtaylor/slate)) — combined with an unbounded ambition surface, this predicts the permanent beta.

#### 3.3 Normalization as a tarpit

Because the core is schema-less, validity is enforced *after the fact*: `normalizeNode` "gets called every time an operation is applied that inserts or updates a node", fixes **one issue at a time**, and any fix "kicks off a *new* normalization pass" until fixpoint ([Normalizing docs](https://docs.slatejs.org/concepts/11-normalizing)). Failure modes, documented in Slate's own docs and issues:

- **Infinite loops** whenever a normalizer flags a state but doesn't truly fix it (docs' own example: setting `url: null` on an invalid link — still invalid, loops forever) ([Normalizing docs](https://docs.slatejs.org/concepts/11-normalizing)).
- **Leaky normalization**: "schema normalization is leaky because it can actually still result in non-normalized documents when you don't expect it" ([issue #2134](https://github.com/ianstormtaylor/slate/issues/2134)); nested validation stacks operating on already-normalized children double-fix and fail ([issue #1363](https://github.com/ianstormtaylor/slate/issues/1363)). The old declarative schema system was eventually ripped out and replaced by imperative `normalizeNode` ([PR #2193](https://github.com/ianstormtaylor/slate/pull/2193), [Migrating docs](https://docs.slatejs.org/concepts/xx-migrating)).
- **Performance**: "if the core Slate logic is causing a noticeable delay, it's because of normalizing"; multi-step transforms need explicit `Editor.withoutNormalizing` wrapping to avoid quadratic re-validation ([Performance docs](https://docs.slatejs.org/walkthroughs/09-performance), [Normalizing docs](https://docs.slatejs.org/concepts/11-normalizing)).

Even so, Slate ended up hard-coding **seven built-in constraints** (every Element contains a Text; merge adjacent identical texts; blocks contain blocks XOR inlines+texts; etc.) ([Normalizing docs](https://docs.slatejs.org/concepts/11-normalizing)) — i.e., "schema-less" was a mirage: the invariants moved from a declared schema into scattered imperative code, the worst of both worlds.

#### 3.4 Performance history

A long trail of large-document issues: initial render mounts every React component ([#1267](https://github.com/ianstormtaylor/slate/issues/1267), [#944](https://github.com/ianstormtaylor/slate/issues/944), [#119](https://github.com/ianstormtaylor/slate/issues/119)); pasting 10,000 lines took ~7s vs ~1s in Tiptap ([#5945](https://github.com/ianstormtaylor/slate/issues/5945), [#2414](https://github.com/ianstormtaylor/slate/issues/2414)); decorations are slow ([#1788](https://github.com/ianstormtaylor/slate/issues/1788)). The current mitigation is opt-in chunking + `content-visibility: auto` on chunks ([Performance walkthrough](https://docs.slatejs.org/walkthroughs/09-performance)) — i.e., the fix arrived years later as an opt-in, because rendering was delegated wholesale to React and React reconciliation of a giant tree was the bottleneck. Also flagged by a Notion engineer: Slate "considers nice, simple code more important than CJK or Android support" ([jitl on HN](https://news.ycombinator.com/item?id=31813550)).

#### 3.5 What Slate got right (steal these)

Plain-JSON serializable document; interfaces over classes (any object with the right shape is a node — friendly to TS structural typing and to storage); commands-vs-transforms layering; paths+points as a *readable* addressing scheme (fragile under mutation, but debuggable); and honest docs about its own pitfalls.

### 4. Cross-cutting comparison (the design space)

| Concern | ProseMirror | Lexical | Slate |
|---|---|---|---|
| Doc shape | Immutable tree, flat inline runs + marks | **Flat `Map<key, node>`**, links by key | Plain-JSON nested tree |
| Identity/addressing | Global integer token positions (must be mapped) | Ephemeral NodeKeys (stable across edits in-session) | Paths (arrays of indices — invalidated by edits) |
| Validity | **Schema up front** (content expressions); transforms schema-aware | Subclass contracts + node transforms to fixpoint on dirty nodes | Schema-less + post-hoc multi-pass normalization |
| Change unit | Transaction = invertible, serializable steps | `editor.update()` closure; dirty-set diff; states swap | Operations (low-level JSON ops) |
| Undo | Inverted steps, mapped forward (collab-safe selective undo) | State snapshots + coalescing | Operation-based |
| Overlays | Decorations (node/widget/inline) in mapped DecorationSets | Missing (workarounds) | Decorations exist but slow historically |
| Extensibility | Plugins with reducer state + view props | Commands (priority) + transforms + listeners + Extensions | Plugin = editor-instance wrapping (overridable functions) |
| Framework coupling | None (own view) | Core none; ecosystem React-first, correcting via Extensions | Rendering delegated to React (`slate-react`) |
| Collab story | Steps + central rebase; Yjs bindings mature | Yjs binding, rough edges | slate-yjs community |
| Status 2026 | Stable, wrapper ecosystem (Tiptap, BlockNote, Remirror) | v0.49.0, fast-moving | Perpetual beta |

The block-editor prior art confirms where this converges: **Notion's model** — every block has `id` (UUID), `type`, `properties`, `content` (array of child block IDs), `parent` (for permissions); "Everything you see in Notion is a block... even pages themselves"; "When you indent something in Notion, you are manipulating relationships between blocks and their content, not just adding a style" ([The data model behind Notion](https://www.notion.com/blog/data-model-behind-notion)). Notion's DOM makes **each text block its own contenteditable** and non-text blocks plain DOM, with custom cross-block selection at the block level ([TechAhead teardown](https://www.techaheadcorp.com/blog/tech-stack-powering-notion-block-based-editor/), [ProseMirror discuss on block-structure editors](https://discuss.prosemirror.net/t/block-structure-editor-by-prosemirror/2620)). **BlockNote** takes the opposite route — one ProseMirror doc under a block-shaped API: "BlockNote is built on top of the widely used ProseMirror and TipTap", organizing documents into blocks so "the user [can] organize their document, and... developers [can] interact with the document from code", at the cost of being "(Mostly) React-only" for its UI layer ([BlockNote docs](https://www.blocknotejs.org/docs), [Liveblocks](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)).

### 5. What a BLOCK editor can skip from ProseMirror — and what it must keep

Because our unit is the block (flat-ish tree of ID-linked blocks, Notion-style), not one contiguous rich-text document:

**Skip:**

1. **Global integer positions and the whole mapping apparatus.** Positions become `(blockId, inlineOffset)`; block identity is a stable ID, immune to edits elsewhere. StepMaps, Mapping composition, bias, mirror maps, `ResolvedPos` — all exist because ProseMirror addresses *one* token stream. With per-block addressing, an edit in block A can never invalidate a position in block B. Only *intra-block* text offsets still need (trivial, local) mapping.
2. **Whole-document content expressions.** A regex grammar with NFA matching over arbitrary nesting collapses to a per-block-type declaration: which child block types are allowed (usually "any block" or "none"), what the inline content schema is, what properties exist. Validation is O(one block), checked at op-apply time.
3. **Cross-block structural surgery** (ReplaceAroundStep, canSplit/canJoin schema searches, findWrapping). Block ops are: `insertBlock`, `deleteBlock`, `moveBlock(parent, index)`, `updateBlockProps`, `splitBlock`/`mergeBlocks` (adjacent, same-type), plus intra-block text ops. Each is small, obviously invertible, and mostly commutes across distinct blocks — which is exactly what makes later p2p sync tractable (block ops ≈ map/list CRDT ops; only intra-block text needs text-CRDT/OT treatment).
4. **Tree-wide normalization passes** (Slate's tarpit). If per-block validation rejects invalid ops and block types define local invariants, there is no fixpoint loop over the document. Lexical's "transforms run only on dirty nodes" is the acceptable residue: per-block transforms on changed blocks.
5. **One giant contenteditable** (optionally). Notion demonstrates per-text-block contenteditable islands + custom block-level selection; this shrinks browser-quirk surface to single paragraphs. The cost — real, and the reason ProseMirror/Lexical chose one surface — is reimplementing cross-block text selection, drag, and screen-reader continuity manually. This is *the* pivotal UX/architecture decision to prototype early.

**Keep (the transferable ideas):**

1. **Immutable state + transactions of invertible ops** (ProseMirror's trail-of-steps): single dispatch pipeline, ops serializable for persistence/sync, inverse ops for history. History = stack of `{ops, inverseOps, selectionBefore/After}` with Lexical-style coalescing for typing.
2. **Schema-driven validation up front** — invalid documents unrepresentable; ops that would violate the (per-block) schema are rejected or adjusted at apply time, never repaired later.
3. **Lexical's flat `Map<id, block>` state shape + copy-on-write + dirty set**: O(1) block lookup, cheap snapshots via structural sharing, reconciliation/persistence/plugins all driven by "which blocks changed". Our block IDs are *persistent* (unlike NodeKeys) because storage and sync need them — Notion, not Lexical, wins on this point.
4. **Selection in state**, block-aware: either a text selection `(blockId, anchor, head)` inside one block, or a block-range selection (set/range of block IDs) — matching Notion's two selection modes.
5. **Command dispatch with priorities** (Lexical) *above* transactions: DOM events → commands (intent) → handlers build transactions (change). Plugins intercept commands; plugin state, if any, is a reducer over committed transactions (ProseMirror).
6. **Decoration-like overlays that are not document content**, keyed by block ID (+ optional intra-block range): selection highlights, collab cursors, search hits, comment anchors, drop indicators. Block-ID keying removes the need for DecorationSet mapping — overlays on untouched blocks survive edits for free.
7. **Defend the model from the browser**: beforeinput/MutationObserver reconciliation loop within each editable island; never trust contenteditable as the source of truth (unanimous across all three editors); treat Android IME/CJK composition as a first-class requirement, not a patch.

---

## Pitfalls (what prior art teaches us NOT to do)

1. **Don't be schema-less and normalize after the fact** (Slate): post-hoc multi-pass normalization produced infinite loops, leaky invariants, and the core perf hotspot — and Slate ended up hard-coding constraints anyway. Validate at op-apply time against a declared per-block schema.
2. **Don't let a UI framework render/own the editable region** (Draft.js's fatal flaw; Slate's perf ceiling): the core must own DOM reconciliation of editable content; bindings only host chrome and non-editable custom views (Lexical's DecoratorNode pattern).
3. **Don't build the framework-agnostic core with a framework-first ecosystem** (Lexical's trap): if official plugins/toolbars/examples ship React-only, you are React-only in practice. Every core feature and plugin must have a vanilla path from day one; bindings stay thin (TanStack discipline).
4. **Don't make positions meaningful only relative to one document version without budgeting for it** (ProseMirror): if any global positions exist, everything holding one must participate in mapping forever. Prefer stable IDs; keep version-relative offsets confined inside single blocks.
5. **Don't live in 0.x forever / break APIs in minors** (Slate a decade in beta; Lexical at 0.49 four years in): ecosystems form around stable operation formats. Freeze the *document schema and operation JSON* earliest of all — storage format stability matters even more than API stability for a tool whose pitch is "readable without the tool".
6. **Don't couple document identity to runtime identity**: Lexical's NodeKeys are ephemeral by design ("Keys are never serialized") which is fine for an in-memory editor but wrong for a persistent block store; Notion's persistent UUIDs are what storage, links, permissions and sync hang off.
7. **Don't ship a toolkit so low-level that everyone needs a wrapper** (ProseMirror): "very basic stuff is extremely hard" is the epitaph to avoid; defaults (paragraph, headings, lists, keymap, history) must work in a few lines, with escape hatches below.
8. **Don't ignore IME/Android/CJK composition until later** (Slate's reputation): composition events differ per keyboard app; retrofitting is near-impossible. Test Gboard/CJK from the first contenteditable prototype.
9. **Don't put overlay/ephemeral state into the document** (the workaround Lexical forces): search highlights and collab cursors must never dirty the persisted doc or the undo history.
10. **Don't rewrite the world when stuck** (Slate 0.50): a total rewrite killed the plugin ecosystem once; design the op/schema layer conservatively enough to evolve additively.

---

## Recommendations for our editor

1. **State shape**: `EditorState = { blocks: Map<BlockId, Block>, rootOrder: BlockId[] (or root block's content), selection: Selection | null, version }`. `Block = { id (uuidv7), type, props, content: BlockId[], parentId }` — Notion's five attributes, Lexical's flat-map runtime. Immutable snapshots with per-block copy-on-write and a dirty-block set per transaction.
2. **Change pipeline**: `dispatch(command)` → command handlers (priority-ordered, `true` stops propagation) → build `Transaction { ops: Op[], invertedOps: Op[], selectionBefore, selectionAfter, meta }` → per-block schema validation at apply → commit swaps state (double-buffer semantics) → dirty-set drives DOM reconciler, listeners, persistence. Ops are a small closed set of JSON-serializable block ops + intra-block text ops; this op log *is* the sync and storage interface.
3. **Schema**: declarative registry of block types: `{ type, propsSchema, allowedChildren, inlineContent: boolean, toDOM/fromDOM, toMarkdown/fromMarkdown }`. Inline rich text = flat run array with mark sets (ProseMirror's model) stored in `props`, never nested elements. Registering a block type is the *only* extension point needed for new content — no subclassing chains.
4. **History**: inverse-op stack (not snapshots) with typing coalescing — inverse ops stay valid under future remote edits because block IDs are stable; this buys collab-safe selective undo almost for free, which is where snapshot undo (Lexical) dead-ends.
5. **Selection**: modeled in state, two modes (text-in-one-block, block-range) like Notion; cross-block text selection is v2 — decide the contenteditable topology (islands vs single surface) by prototyping *both* against Android IME and screen readers before committing. This is the highest-risk unknown; everything else in this note is well-trodden.
6. **Overlays**: decoration API keyed by `blockId` + optional `[from, to]` intra-block range + widget insertion points, supplied by plugins per commit, rendered by the reconciler, never persisted, never in undo.
7. **Plugins**: a plugin = `{ commands?, keymap?, blockTypes?, overlays?(state), state?: reducer over transactions, domEventHandlers? }` — ProseMirror's reducer-state idea with Lexical's command dispatch, zero React in sight; framework bindings subscribe to committed states and render chrome only.
8. **Collab posture now**: even before p2p sync exists, keep every mutation an ordered op with a stable-ID target and an inverse — that is ProseMirror's "collab-ready by construction" property. Later, block-structure ops map to map/list CRDTs and intra-block text to a text CRDT (or PM-style central rebase for the hosted path); the editor core shouldn't care which transport wins.
9. **Stability contract**: version the document schema and op format from v0.1 and treat them as the public API; editor APIs may churn pre-1.0, the persisted format may not.

---

## Sources

- [ProseMirror Guide](https://prosemirror.net/docs/guide/) — document model, schema, transactions, positions, plugins, decorations, collab
- [ProseMirror (announcement / design essay) — Marijn Haverbeke](https://marijnhaverbeke.nl/blog/prosemirror.html)
- [Collaborative Editing in ProseMirror — Marijn Haverbeke](https://marijnhaverbeke.nl/blog/collaborative-editing.html)
- [prosemirror-transform README](https://github.com/ProseMirror/prosemirror-transform/blob/master/src/README.md)
- [ProseMirror schema example](https://prosemirror.net/examples/schema/)
- [discuss.prosemirror.net — "Prosemirror is very hard on basic stuff like Suggestions"](https://discuss.prosemirror.net/t/prosemirror-is-very-hard-on-basic-stuff-like-suggestions/2995)
- [HN — ProseMirror learning-curve experience](https://news.ycombinator.com/item?id=16825034)
- [Lexical's Design](https://lexical.dev/docs/design)
- [Lexical — Editor State](https://lexical.dev/docs/concepts/editor-state)
- [Lexical — Nodes](https://lexical.dev/docs/concepts/nodes)
- [Lexical — Key Management](https://lexical.dev/docs/concepts/key-management)
- [Lexical — Commands](https://lexical.dev/docs/concepts/commands)
- [Lexical — History](https://lexical.dev/docs/concepts/history) / [@lexical/history](https://lexical.dev/docs/packages/lexical-history)
- [Lexical — Extensions intro](https://lexical.dev/docs/extensions/intro)
- [Lexical — Vanilla JS quick start](https://lexical.dev/docs/getting-started/quick-start)
- [lexical on npm (v0.49.0, Aug 2026)](https://www.npmjs.com/package/lexical?activeTab=versions) / [GitHub releases](https://github.com/facebook/lexical/releases)
- [facebookarchive/draft-js (archived)](https://github.com/facebookarchive/draft-js)
- [HN — "Internally, we've been replacing Draft.js with Lexical"](https://news.ycombinator.com/item?id=31022152)
- [HN — "Lexical – a web text editor framework that powers Facebook"](https://news.ycombinator.com/item?id=31813550)
- [Doctrine — Should we use Lexical to edit our legal graph?](https://medium.com/doctrine/should-we-use-lexical-to-edit-our-legal-graph-61aa9cfab096)
- [How to Migrate from Draft.js to Lexical in 2026](https://dev.to/dragogargo/how-to-migrate-from-draftjs-to-lexical-in-2026-complete-guide-4960)
- [JetRockets — Want to use Lexical without React?](https://jetrockets.com/blog/want-to-use-lexical-without-react) / [lexical-vanilla-plugins](https://github.com/jetrockets/lexical-vanilla-plugins)
- [facebook/lexical issue #2313 — Does it really work without React?](https://github.com/facebook/lexical/issues/2313)
- [Slate README (beta status, principles)](https://github.com/ianstormtaylor/slate)
- [Slate — Migrating (0.50 rewrite)](https://docs.slatejs.org/concepts/xx-migrating) / [issue #3215 — Slate 0.50+](https://github.com/ianstormtaylor/slate/issues/3215)
- [Slate — Normalizing](https://docs.slatejs.org/concepts/11-normalizing)
- [Slate — Improving Performance](https://docs.slatejs.org/walkthroughs/09-performance)
- [Slate — Changelog](https://docs.slatejs.org/general/changelog)
- Slate issues: [#2134 leaky schema normalization](https://github.com/ianstormtaylor/slate/issues/2134), [#1363 nested validation stacks](https://github.com/ianstormtaylor/slate/issues/1363), [PR #2193 operations-based normalization](https://github.com/ianstormtaylor/slate/pull/2193), [#1267](https://github.com/ianstormtaylor/slate/issues/1267), [#944](https://github.com/ianstormtaylor/slate/issues/944), [#119](https://github.com/ianstormtaylor/slate/issues/119), [#790 dynamic rendering](https://github.com/ianstormtaylor/slate/issues/790), [#1788 decorations slow](https://github.com/ianstormtaylor/slate/issues/1788), [#2414](https://github.com/ianstormtaylor/slate/issues/2414), [#5945 slow paste vs Tiptap](https://github.com/ianstormtaylor/slate/issues/5945)
- [Liveblocks — Which rich text editor framework should you choose in 2025?](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)
- [Notion — The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)
- [TechAhead — The tech stack behind Notion's block-based editor](https://www.techaheadcorp.com/blog/tech-stack-powering-notion-block-based-editor/)
- [discuss.prosemirror.net — Block structure editor by ProseMirror](https://discuss.prosemirror.net/t/block-structure-editor-by-prosemirror/2620)
- [BlockNote docs](https://www.blocknotejs.org/docs)
- [Juro — Tech deep dive: CKEditor and ProseMirror core designs](https://medium.com/juro-tech/tech-deep-dive-exploring-ckeditor-and-prosemirrors-core-designs-50ee608bbdc5)
- [StepWise — ProseMirror Collab Performance](https://stepwisehq.com/blog/2023-07-25-prosemirror-collab-performance/)
- [Moment devlog — Lies I was Told About Collaborative Editing, Pt. 2](https://www.moment.dev/blog/lies-i-was-told-pt-2)
