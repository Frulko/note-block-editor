# Future-Proofing: Collaboration, Offline-First P2P Sync, and Native Editors on a Shared Schema

Research note — August 2026. Roadmap-level: which schema decisions made **today** keep collaboration, p2p sync, and native editors cheap to add **later**, without shipping a CRDT in v1.

## TL;DR

- **Do not pick a CRDT library now; pick a CRDT-compatible schema now.** Every hard-won lesson from Yjs, Automerge, Loro, and Peritext converges on the same handful of schema properties: stable IDs, identity-anchored positions, operation-shaped mutations, and per-property (not whole-object) writes.
- **Yjs is still the ecosystem default in 2026** (~920K weekly downloads, richest editor bindings, y-prosemirror/Tiptap, Hocuspocus/Liveblocks/PartyKit servers); v14 is in beta with change attribution. **Automerge 3 (Aug 2025)** fixed its historic memory problem (Moby-Dick doc: 700 MB → 1.3 MB) and owns the "git-like history" niche. **Loro 1.x** is the performance leader with the best data-model fit for a block editor: Peritext-inspired rich text, a **movable tree** (Kleppmann's algorithm), MovableList, and official Swift bindings.
- **Even Notion itself** — the archetypal server-first app — retrofitted a CRDT data model in 2025 to ship offline mode ("pages are dynamically migrated to our new CRDT data model for conflict-resolution"). The retrofit is what we want to make cheap.
- **Pure p2p is not a realistic default.** WebRTC mesh tops out at a handful of peers, public signaling servers rot, and every serious local-first product (Anytype, AFFiNE, Automerge ecosystem) runs relay/sync nodes. Design for "sync-server-assisted p2p": dumb, encrypted, replaceable relays. iroh 1.0 (June 2026) is the strongest p2p transport story for native apps.
- **The persisted model must never contain integer indexes or DOM positions.** Yjs relative positions exist precisely because "the index-range is invalidated as soon as a remote change manipulates the document." Persist `(blockId, anchor)` pairs, never offsets.
- **Parent + ordered-children is the right shape** (Notion: `content` array of IDs + `parent_id` upward pointer for permissions). Fractional indexing is fine for canvas-like data (Figma's own choice) but interleaves on concurrent runs — for block sequences prefer an ordered-list abstraction the CRDT can own, and treat fractional keys as an implementation detail behind it.
- **Rich text semantics matter more than rich text encoding**: Peritext showed that formatting must be stored as spans anchored to stable character IDs with per-mark merge semantics (bold expands, links don't). Storing inline formatting as pre-tokenized HTML or index-based ranges forecloses this.
- **Native Swift on the same schema is proven feasible**: Craft runs a fully native block editor with its own operation-based sync engine over hundreds of thousands of blocks; Loro ships loro-swift (UniFFI, XCFramework); TextKit 2 is mature (WWDC 2025/2026 sessions target exactly this use case). Feasibility hinges on the JSON schema being platform-neutral, not on the web editor.
- **Schema versioning is unsolved-in-general (Cambria) but cheap-in-particular**: a `schemaVersion` field per document plus forward-only migration functions covers 95% of real needs; add it on day one.

---

## Findings

### 1. The CRDT landscape for block documents in 2026

#### 1.1 Yjs — the incumbent

Yjs remains the default choice for collaborative editing on the web: roughly **920K weekly npm downloads and 17K GitHub stars**, versus ~85K for Automerge and ~12K for Loro ([PkgPulse: Yjs vs Automerge vs Loro 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)). Its moat is the ecosystem, not the algorithm:

- **Editor bindings**: ProseMirror/Tiptap ([y-prosemirror](https://github.com/yjs/y-prosemirror)), CodeMirror 6, Monaco, Quill.
- **Providers**: y-websocket, y-webrtc, y-indexeddb; production servers Hocuspocus, Liveblocks, PartyKit.
- **Bundle**: ~18 kB min+gz pure JS — no WASM. Loro is ~180 kB and Automerge ~320 kB of Rust+WASM ([PkgPulse](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)).

Concepts from Yjs that matter for our schema regardless of library choice:

- **Shared types**: `Y.Map`, `Y.Array`, `Y.Text`, and `Y.XmlFragment`/`Y.XmlElement`/`Y.XmlText`. y-prosemirror "maps a Y.XmlFragment to the ProseMirror state" ([y-prosemirror README](https://github.com/yjs/y-prosemirror)) — i.e. the rich-text tree of a block lives in a CRDT-native XML-ish structure, not in serialized HTML.
- **Relative positions**: index-based positions fail in collaborative documents because "the index-range is invalidated as soon as a remote change manipulates the document." A relative position "fixates to an element in the shared document and is not affected by remote changes," and when all clients sync, all relative positions translate to the same index — a guarantee OT-style position mapping cannot make ([Yjs docs: relative positions](https://docs.yjs.dev/api/relative-positions)). This is the strongest single argument for identity-anchored (not offset-anchored) positions in any persisted artifact: cursors, comments, links into documents.
- **Awareness**: ephemeral presence state (cursor, name, selection) travels in a separate non-persisted protocol (`y-protocols/awareness`). Lesson: presence is *not* document state and must never enter the persisted schema.
- **Versioning is Yjs's weak spot**: only `Y.UndoManager`-level history; storing every named version requires an extra Version Vector + Delete Set per version ([PkgPulse](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026), [Velt CRDT guide 2026](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)).
- **Yjs v14** is at release-candidate stage (v14.0.0-rc.x through mid-2026), introducing an **AttributionManager** that attributes changes to specific clients; the y-prosemirror dev branch and y-quill already track v14 betas, and downstream projects (e.g. WordPress Gutenberg RTC) are planning upgrades ([yjs releases](https://github.com/yjs/yjs/releases), [Gutenberg issue #77004](https://github.com/WordPress/gutenberg/issues/77004)). Yjs is actively developed, not in maintenance mode.

#### 1.2 Automerge — history as a product feature

Automerge's identity is a **JSON-like CRDT with a git-like DAG of changes**: forking, merging, cherry-picking, granular diffs between versions, per-change attribution ([automerge/automerge](https://github.com/automerge/automerge)). Its historic disqualifier — memory — was fixed in **Automerge 3.0 (August 2025)**: the on-disk columnar compression format is now used *in memory*, cutting usage 10x–100x. Pasting Moby Dick: 700 MB in Automerge 2 → **1.3 MB in Automerge 3**; a pathological document that took 17 hours to load now opens in 9 seconds. Same file format, near-fully backwards-compatible API ([Automerge 3.0 announcement](https://automerge.org/blog/automerge-3/)).

**Automerge-Repo** is the "batteries-included" layer: many-documents management with pluggable storage (single `StorageAdapter`: filesystem, IndexedDB, S3) and multiple `NetworkAdapter`s (websocket client/server, `MessageChannel`, `BroadcastChannel` for tab-to-tab) ([Automerge Repo announcement](https://automerge.org/blog/automerge-repo/), [networking docs](https://automerge.org/docs/reference/repositories/networking/)). Notable current limitation: the sync protocol requires a document to be fully loaded in memory to sync it ([storage docs](https://automerge.org/docs/reference/repositories/storage/)).

Ecosystem beyond the core is thinner than Yjs: the ProseMirror binding is alpha-grade ([PkgPulse](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)).

#### 1.3 Loro — the best data-model fit for a block editor

Loro is a Rust CRDT library (JS via WASM, **Swift via UniFFI**) that reached **1.0 with a stable encoding schema** and 10–100x faster document import ([Loro 1.0](https://loro.dev/blog/v1.0), [loro.dev](https://loro.dev/)). What makes it interesting for us is that its container types map one-to-one onto a block editor's needs ([loro-crdt npm](https://www.npmjs.com/package/loro-crdt)):

- **Text** with rich-text support using **Fugue** (minimal-interleaving list CRDT) and Peritext-inspired formatting semantics;
- **MovableList** for ordered collections with real move support;
- **MovableTree** for hierarchy — implementing **Kleppmann et al.'s highly-available tree move algorithm**, so concurrent reparent + reorder cannot create cycles or duplicate blocks ([Movable tree CRDTs and Loro's implementation](https://loro.dev/blog/movable-tree), [HN discussion](https://news.ycombinator.com/item?id=41099901));
- **LWW Map** for block properties.

Benchmarks (B4 editing trace, 260K-char document; Loro's own and third-party summaries): apply 260K edits Loro 290ms / Yjs 430ms / Automerge 680ms; encoded size Loro 68 kB / Yjs 160 kB / Automerge 250 kB; loaded memory Loro 15 MB / Yjs 28 MB / Automerge 41 MB ([PkgPulse](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026), [Loro performance docs](https://loro.dev/docs/performance)). Loro and Automerge can retain the full editing DAG per keystroke; Yjs needs extra bookkeeping per saved version ([Velt guide](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)).

Caveats: youngest ecosystem of the three (~12K weekly downloads), loro-prosemirror exists but bindings are early, sync servers are DIY ([PkgPulse](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)). The [loro-swift](https://github.com/loro-dev/loro-swift) bindings (MIT, prebuilt `loroFFI.xcframework`, iOS/macOS/visionOS/watchOS/tvOS, 19+ releases, versions tracking core ~1.10.x) are generated via [loro-ffi/UniFFI](https://github.com/loro-dev/loro-ffi) — the only first-party Swift story among the three libraries.

#### 1.4 Peritext — what "rich text CRDT" actually has to mean

[Peritext](https://www.inkandswitch.com/peritext/) (Litt, Lim, Kleppmann, van Hardenberg; [CSCW 2022](https://dl.acm.org/doi/abs/10.1145/3555644)) is the reference semantics for merging concurrent rich-text edits. Key ideas:

- Formatting is stored as **spans linked to stable identifiers of the first and last character**, kept alongside the plain-text character sequence; the final formatted text is derived deterministically so concurrent operations commute.
- **Different marks need different merge semantics**: a bold span should expand to cover text typed at its boundary; a link should not; comments may overlap arbitrarily. Flattening to HTML/Markdown at merge time destroys the information needed to make these calls.
- The prototype was validated with property-based testing and integrated with a real editor UI.

Two consequences for schema design: (a) inline formatting must be representable as **mark spans over identity-addressed text**, not as nested tokens baked into strings; (b) the plain-text CRDT and the formatting layer are separable concerns ([peritext#31](https://github.com/inkandswitch/peritext/issues/31) discusses making Peritext agnostic to the underlying text CRDT). Loro's rich text implements this family of semantics natively; Yjs's `Y.Text`/`Y.XmlText` attribute model predates Peritext and has coarser mark-expansion behavior.

#### 1.5 Ordering: fractional indexing vs. list CRDTs vs. movable structures

- **Fractional indexing** (position = arbitrary-precision fraction between neighbors) is what Figma uses for child ordering — chosen deliberately because "the interleaving drawback would be a concern for a text editor but isn't really a concern for Figma" ([Figma: Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/), [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). Known failure modes: **interleaving of concurrent runs** (A inserts a,b,c; B inserts x,y,z at the same spot → a,x,b,y,c,z), and **precision exhaustion** if you use floats instead of arbitrary-precision strings ([Evan Wallace: CRDT Fractional Indexing](https://madebyevan.com/algos/crdt-fractional-indexing/), [Liveblocks on fractional indexing](https://liveblocks.io/blog/how-crdts-and-sync-engines-keep-realtime-lists-ordered-with-fractional-indexing)). There are non-interleaving refinements (e.g. [LSeq variants](https://www.bartoszsypytkowski.com/non-interleaving-lseq/)) but they reintroduce complexity.
- **List CRDTs with move**: naive move = delete+reinsert, which under concurrency **duplicates** the moved element. Kleppmann's [Moving Elements in List CRDTs (PaPoC 2020)](https://martin.kleppmann.com/papers/list-move-papoc20.pdf) fixes this by treating "position of X" as an LWW register over stable element identities.
- **Tree move**: concurrent reparenting can create cycles; [Kleppmann et al.'s highly-available move operation for replicated trees](https://martin.kleppmann.com/2020/04/27/papoc-list-move.html) (IEEE TPDS 2021) resolves this deterministically and is what Loro's MovableTree implements ([Loro movable tree blog](https://loro.dev/blog/movable-tree)). Discussion of Loro's design notes that sibling ordering via fractional index has known issues, and that block-editor-style ordering is better served by identity-anchored ("previous sibling") ordering ([HN thread](https://news.ycombinator.com/item?id=41099901)).

The synthesis: **a block's position = (parentId, position-among-siblings)**, where position-among-siblings is owned by whatever ordering mechanism the storage layer uses — a plain array in single-user JSON, fractional keys in a SQLite row store, a list CRDT under collaboration. The schema must expose *intent* ("move block B under P after A"), never raw indexes.

### 2. Local-first and sync transports

#### 2.1 The local-first ideals — and their honest caveats

The [Ink & Switch local-first essay](https://www.inkandswitch.com/essay/local-first/) defines seven ideals (no spinners; multi-device; optional network; seamless collaboration; the Long Now; security/privacy by default; user ownership) and names CRDTs the foundational technology. It is equally valuable for its caveats, all still true in 2026: CRDT history accumulates (mitigated by Automerge 3 / Loro compression, not eliminated); **p2p networking remains unreliable and NAT traversal problematic**; schema evolution and permission models for decentralized systems are largely unsolved.

The "storage readable without the tool" pillar of our project is the same idea as Steph Ango's (Obsidian CEO) [File over app](https://stephango.com/file-over-app): "the files you create are more important than the tools you use to create them." Markdown/CSV/SQLite outputs are our Long Now story, and they must remain derivable from the canonical schema at all times.

#### 2.2 Realistic assessment: pure p2p vs. sync-server-assisted

- **y-webrtc**: works for demos and small groups; a full mesh grows O(n²) connections and hits practical walls at a handful of peers; it still requires a signaling server, and the public ones have a history of being down ([y-webrtc#43: public signaling servers down?](https://github.com/yjs/y-webrtc/issues/43), [BlogGeek: WebRTC P2P mesh can't scale](https://bloggeek.me/webrtc-p2p-mesh/amp/)). Browser tabs can't accept inbound connections without WebRTC at all — the browser is a second-class p2p citizen by construction.
- **y-websocket / Hocuspocus / PartyKit / Liveblocks**: the boring, dominant deployment model — a dumb relay that fans out CRDT updates and optionally persists them. Liveblocks even open-sourced its sync engine (Feb 2026, AGPL) ([Velt guide](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)).
- **Automerge sync**: per-document Bloom-filter-based protocol, transport-agnostic via NetworkAdapters (websocket, MessageChannel, BroadcastChannel) ([Automerge networking docs](https://automerge.org/docs/reference/repositories/networking/)) — the cleanest demonstration that **sync protocol and transport are separable**.
- **iroh** ([n0-computer/iroh](https://github.com/n0-computer/iroh)) reached **1.0 in June 2026**: "dial devices by key, not IP" — QUIC + TLS 1.3 with hole-punching and automatic relay fallback, stable wire protocol, and official **Python, Node.js, Swift, and Kotlin bindings**; default free relays run by n0 in US/EU/Asia ([TechTimes on iroh 1.0](https://www.techtimes.com/articles/318490/20260616/peer-peer-library-iroh-10-ships-dial-devices-key-not-ip-address.htm), [iroh FAQ](https://docs.iroh.computer/about/faq)). iroh-blobs (BLAKE3 content-addressed transfer) and iroh-docs (eventually-consistent KV) exist as ready protocols. For our later native + p2p phase, iroh-as-transport + CRDT-as-payload is the credible stack; note the relays are still there — even the best p2p story is *relay-assisted*.
- **Anytype's production answer** (below) is the same: p2p when possible, self-hostable nodes always available.

**Conclusion**: "pure p2p" is a marketing phrase; every shipping system is p2p-capable but relay/server-assisted. The architectural requirement on us is only this: **sync must be expressible as "exchange opaque update blobs between replicas, in any order, over any channel."** That property comes free with op-based CRDTs and is impossible with REST-style "PUT the new document."

#### 2.3 Even the centralized incumbent converged here

Notion spent years on WASM SQLite caching ([How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite): OPFS, per-tab Web Workers, SharedWorker electing an active writer) and then shipped Offline Mode (announced Aug 2025): SQLite promoted from best-effort cache to persistent store, push-based invalidation channels per page, an `offline_page`/`offline_action` bookkeeping forest — and, crucially, pages marked offline are "**dynamically migrated to our new CRDT data model for conflict-resolution**" ([How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline), [TechCrunch](https://techcrunch.com/2025/08/20/finally-notion-now-works-without-an-internet-connection/)). The market leader retrofitting CRDTs onto a 10-year-old block schema is the strongest available evidence that (a) block-granular schemas *can* be migrated to CRDTs later, and (b) it is expensive enough that you want the schema shaped for it from day one.

### 3. Existing local-first Notion-likes

#### 3.1 AFFiNE / BlockSuite — CRDT-native, Yjs as the document store

BlockSuite is AFFiNE's editor framework, "natively built on the CRDT library Yjs" — CRDT as native state management, not a bolted-on collaboration plugin ([BlockSuite overview](https://blocksuite.io/blocksuite-overview.html), [toeverything/blocksuite](https://github.com/toeverything/blocksuite)). Key architectural takeaways:

- **CRDT-native unidirectional data flow**: the YModel is the single source of truth. UI events produce operations that mutate the Yjs doc; the UI re-renders from model events, identically for local and remote changes. A keystroke becomes a serializable `InsertOperation` before it touches state ([AFFiNE: What happens after you press A in a collaborative editor?](https://affine.pro/blog/what-happens-after-you-press-a-in-a-collaborative-editor-data-model)). This "operation-shaped mutations" discipline is exactly what makes a non-CRDT core CRDT-upgradable.
- **Reactive facade over Yjs**: BlockSuite wraps Y types so block models expose native JS values; developers "don't need in-depth understanding of Yjs" ([Block reactive guide](https://docs.affine.pro/blocksuite-wip/store/block-reactive), [block model](https://docs.affine.pro/blocksuite-wip/store/block-model)). Undo/redo falls out of the CRDT for free.
- **Per-block inline editors**: rich text lives in many small inline editors, one per block, instead of one giant contenteditable — reducing rich-text complexity to the paragraph level ([BlockSuite overview](https://blocksuite.io/blocksuite-overview.html)).
- **Costs**: BlockSuite is a 60+ package sub-monorepo ([DeepWiki on AFFiNE](https://deepwiki.com/toeverything/AFFiNE/2.2-blocksuite-editor-system)); the hard Yjs dependency means every consumer ships the CRDT even single-user; and binding a UI framework directly to CRDT types couples the editor to Yjs's type system permanently. Their community has an ongoing performance-improvement track for the editor ([AFFiNE community](https://community.affine.pro/c/build-in-public/performance-improvement-on-blocksuite-editor)).

#### 3.2 Anytype / any-sync — encrypted DAGs with dedicated node roles

[any-sync](https://github.com/anyproto/any-sync) (Go) is Anytype's protocol for "high-performance, local-first, peer-to-peer, end-to-end encrypted collaborative apps": data is stored as **encrypted DAGs of cryptographically signed CRDT changes** organized into *spaces*; each device independently applies and verifies updates; formats span chats, pages, and databases, with files stored separately. The network has four node roles: **sync nodes** (store/relay spaces), **file nodes**, **consensus nodes** (validate ACL changes — permissions are the one thing they do *not* leave to CRDT merge), and **coordinator nodes** (network configuration) ([any-sync README](https://github.com/anyproto/any-sync)). Lessons: (a) E2EE + local-first is achievable but forces you to run real infrastructure — "p2p" still means self-hostable nodes, not serverless; (b) **ACL/permissions want consensus, not CRDT semantics**; (c) inventing a bespoke protocol costs a protocol team — Anytype's model has stayed niche partly because nothing else speaks any-sync.

#### 3.3 SiYuan — git-like snapshot sync, no CRDT

SiYuan syncs via **encrypted, deduplicated snapshots** (its `dejavu` library — essentially a private git), with boot/interval/manual/exit sync triggers and a WebSocket "perception" channel so devices notice each other's syncs. Conflicts produce **conflict copies** or a best-effort auto-merge ([DeepWiki: siyuan overview](https://deepwiki.com/siyuan-note/siyuan/1-overview)). Users still hit real conflicts and data-loss edges ([siyuan#13065: reduce probability of conflicts](https://github.com/siyuan-note/siyuan/issues/13065)); third parties have built alternative sync layers ([better-sync-siyuan](https://github.com/DD3Boh/better-sync-siyuan)). Lesson: **file-snapshot sync without CRDT semantics ends in "Conflict copy" documents** — acceptable for single-user multi-device, unacceptable for collaboration, and the escape hatch (per-block merge) requires exactly the schema properties this note recommends.

### 4. Native editors on the same schema

#### 4.1 Existence proof: Craft

Craft is a fully native Swift block editor (Apple Design Award 2021) with block-based documents across iOS/iPadOS/macOS. Having evaluated Firebase, Realm, and existing CRDT protocols and found them lacking for offline + real-time + large documents, Craft built a **state-machine-driven, operation-based sync engine** supporting multi-device real-time editing online or offline, "optimized for speed and scalability, supporting hundreds of thousands of blocks per document" ([App Stacks: Craft](https://appstacks.club/craft), [Craft on the App Store](https://apps.apple.com/us/app/craft-write-docs-ai-editing/id1487937127)). The load-bearing fact: a native block editor with operation-based offline sync at Notion scale **exists and is a mainstream product** — and its sync unit is the *operation on a block*, matching the schema discipline above.

#### 4.2 The text stack: TextKit 2

TextKit 2 is the modern Apple text engine for exactly this job — custom rich-text editing beyond built-in controls, with viewport-based layout for performance on large documents. It is under active development: WWDC 2025 "Cook up a rich text experience in SwiftUI" and WWDC 2026 "Viewport rendering surfaces and attachment reuse in TextKit 2" ([Axiom TextKit 2 reference](https://charleswiltgen.github.io/Axiom/reference/textkit-ref), [Michael Tsai: TextKit 2 — The Promised Land](https://mjtsai.com/blog/2025/08/15/textkit-2-the-promised-land/)). Open-source rich-text editors on TextKit exist ([RichTextKit](https://swiftpackageindex.com/danielsaidi/RichTextKit) et al.). The BlockSuite per-block-inline-editor pattern transfers directly: one lightweight TextKit 2 text view (or SwiftUI `AttributedString` editor) per block, block chrome in SwiftUI — never one giant text view for the whole document.

#### 4.3 CRDT availability on Swift

If/when the core goes CRDT: [loro-swift](https://github.com/loro-dev/loro-swift) ships a prebuilt XCFramework tracking Loro core (~1.10.x, MIT, all Apple platforms) via [UniFFI](https://github.com/loro-dev/loro-ffi); Automerge has official Swift bindings (automerge-swift); Yjs has **no** first-party native binding (community ports exist, e.g. byte-compatible Go port [ygo](https://github.com/Deln0r/ygo), but nothing blessed for Swift). iroh 1.0 ships official Swift bindings for transport ([TechTimes](https://www.techtimes.com/articles/318490/20260616/peer-peer-library-iroh-10-ships-dial-devices-key-not-ip-address.htm)). This is a real asymmetry: **choosing Yjs today means the future Swift editor cannot share the CRDT layer**; choosing Loro (or Automerge) keeps web + Swift on one Rust core.

#### 4.4 Schema portability rules (what makes a JSON block schema native-consumable)

Derived from Notion's model, BlockSuite, and Craft:

1. **Pure data, zero platform vocabulary**: no DOM node names, no CSS classes, no pixel values as semantics, no HTML strings inside properties. Notion's block = `{id, type, properties, content: [ids], parent_id}` ([The data model behind Notion](https://www.notion.com/blog/data-model-behind-notion)) — nothing in it knows about the web.
2. **Flat map of blocks + ID references**, not a deeply nested JSON tree: cheap partial loading, cheap moves, natural SQLite row mapping, and native editors can materialize only the visible subtree.
3. **Inline content as typed runs/marks** (text + mark spans), not markup strings — so TextKit's `NSAttributedString` and the web's spans both render from the same source without parsing HTML.
4. **Closed set of primitive value types** (string, number, bool, id-ref, rich-text-runs, date) — everything a Swift `Codable`, a Kotlin data class, and a TS interface can express identically.
5. **Unknown-type preservation**: a consumer that doesn't understand `type: "kanban"` must round-trip the block untouched (forward compatibility across editor versions and platforms).

### 5. Schema versioning

- Per-document `schemaVersion` integer + forward-only pure migration functions is the boring standard; it works because we control all readers in v1.
- The research frontier is [Cambria](https://www.inkandswitch.com/cambria/) (Ink & Switch): bidirectional **edit lenses** translating documents (and edits) between schema versions on demand, integrated with Automerge for cross-version p2p collaboration ([cambria-project](https://github.com/inkandswitch/cambria-project), [CIC paper](https://dl.acm.org/doi/abs/10.1145/3447865.3457963)). Cambria never became production infrastructure — treat it as a warning that **in a p2p world, old and new clients collaborate on the same doc simultaneously**, so migrations can't be one-shot rewrites. The cheap hedge: additive-only evolution (add fields, never repurpose), `schemaVersion` recorded per document, and unknown-field preservation.

---

## Pitfalls (what prior art teaches us NOT to do)

1. **Don't persist integer offsets or DOM positions anywhere.** Cursors, comments, deep links, and annotations anchored by index break under any concurrent edit; this is the entire reason Yjs relative positions exist ([Yjs docs](https://docs.yjs.dev/api/relative-positions)). If it's in the saved file as `{ "offset": 141 }`, it's already wrong.
2. **Don't store rich text as HTML/Markdown strings in block properties.** Peritext shows merges need per-mark semantics over identity-addressed characters ([Peritext](https://www.inkandswitch.com/peritext/)); string-encoded markup makes future fine-grained merging (and native rendering) a parsing problem. Markdown is an *export*, not the model.
3. **Don't implement move as delete + reinsert.** Under concurrency it duplicates blocks (list case, [Kleppmann PaPoC 2020](https://martin.kleppmann.com/papers/list-move-papoc20.pdf)) or creates cycles (tree case, solved by the [tree-move algorithm](https://martin.kleppmann.com/2020/04/27/papoc-list-move.html)). Model move as its own operation from day one, even in the non-CRDT core.
4. **Don't put fractional floats in the schema.** Float positions exhaust precision and interleave concurrent runs ([Evan Wallace](https://madebyevan.com/algos/crdt-fractional-indexing/), [Figma](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)); if fractional keys appear at all (SQLite ordering), they're arbitrary-precision strings and an implementation detail, never API.
5. **Don't hard-couple the editor core to one CRDT library's types** (BlockSuite's Yjs coupling). It works for AFFiNE but means every consumer ships Yjs forever and the model layer can never move to Loro/Automerge/native. Keep the CRDT behind the same interface the plain-JSON store implements.
6. **Don't bet on serverless pure p2p.** Public signaling servers die ([y-webrtc#43](https://github.com/yjs/y-webrtc/issues/43)), browser mesh doesn't scale ([BlogGeek](https://bloggeek.me/webrtc-p2p-mesh/amp/)), and every shipping local-first product runs assisting infrastructure (any-sync nodes, Automerge sync servers, iroh relays). Design the protocol to be relay-agnostic instead.
7. **Don't leave conflict handling to "conflict copy" files** (SiYuan). It silently punts merge work to users and forecloses collaboration; per-block merge requires the stable-ID, op-shaped schema anyway — so shape the schema now.
8. **Don't put permissions/ACL inside the CRDT-merged document.** Anytype routes ACL changes through consensus nodes precisely because "last writer wins on who is admin" is a security hole ([any-sync](https://github.com/anyproto/any-sync)). Notion likewise keeps `parent_id` as the permission spine outside content ordering ([Notion data model](https://www.notion.com/blog/data-model-behind-notion)).
9. **Don't persist ephemeral state.** Presence, cursors, selections travel on the awareness channel and die with the session (Yjs awareness; Loro EphemeralStore). Anything persisted must deserve the Long Now.
10. **Don't treat schema migration as a one-shot rewrite.** In offline/p2p worlds, v1 and v3 clients meet on the same document (the Cambria problem). Additive evolution + version stamps + unknown-field preservation are mandatory hygiene.
11. **Don't assume the whole workspace loads into memory.** Automerge-Repo still requires in-memory docs to sync; Notion's offline mode is page-granular with explicit bookkeeping. Document = unit of load/sync; workspace = many documents.

---

## Recommendations for our editor

1. **v1 core stays CRDT-free but CRDT-shaped.** Plain TypeScript document store, no Yjs/Loro/Automerge dependency. The upgrade path is preserved entirely by schema discipline (below), exactly the retrofit Notion executed in 2025 — except we make it cheap.
2. **Adopt the Notion block shape as the canonical schema**: flat `Map<BlockId, Block>` with `Block = { id, type, version, props, children: BlockId[], parentId }`. `children` orders; `parentId` is the redundant upward pointer (validated, auto-repaired on load). IDs are UUIDv4/nanoid, generated client-side at creation, never reused, never semantic.
3. **All mutations flow through a closed set of operations** — `insertBlock`, `deleteBlock`, `moveBlock(id, newParent, afterSibling)`, `setProp(id, key, value)`, `textEdit(id, richTextDelta)` — applied by a single reducer over the store (BlockSuite's unidirectional flow, minus Yjs). Undo/redo = inverse ops. This is simultaneously our extension API, our test harness, and the future CRDT/sync boundary.
4. **`moveBlock` is a first-class op** (parent + after-sibling anchor, both by ID — never an index). Sibling *anchors by identity*, matching both the list-move and tree-move literature, and immune to the fractional-index interleaving trap.
5. **Rich text is `{ text: string, marks: [{type, start, end, attrs}] }` per block**, with start/end as UTF-16 code-unit offsets *only inside the op payload*, normalized immediately into the store; persisted anchors (comments, links) use `(blockId, markId | run-relative anchor)`, never raw offsets. Mark types declare expansion behavior (bold: expand-after; link: no-expand) per Peritext.
6. **Pick Loro as the *presumptive* future CRDT and let it audit the schema now**: its Text/MovableList/MovableTree/LWW-Map containers must have an obvious 1:1 mapping from our block schema (they do, if we follow 2–5). Loro over Yjs because of the movable tree, Peritext-style rich text, stable 1.0 encoding, and loro-swift sharing one Rust core with the future native editor; over Automerge because block editors are performance-sensitive and Loro's data model fits better. Revisit at collaboration kickoff — do not add the dependency before then.
7. **Sync design (later phase): replicas exchanging opaque update blobs over pluggable transports** (Automerge-Repo's adapter pattern is the model). Default deployment: a dumb websocket relay (self-hostable, ~100 lines). Native/p2p phase: iroh as transport, same blobs. Never build a bespoke wire protocol à la any-sync.
8. **Native Swift editor plan**: same JSON schema (rule set §4.4), per-block TextKit 2 views, SwiftUI chrome; when collaboration exists, loro-swift consumes the same Loro core as the web. Craft proves the product ceiling; we get to skip building their proprietary sync engine.
9. **Storage-readable-without-the-tool = projections, not the model**: Markdown/CSV/SQLite exports are deterministic derivations of the canonical schema (SQLite mirror can be live: `blocks(id, parent_id, order_key, type, props_json)`). Lossy formats (Markdown) are one-way; SQLite/JSON round-trip. This satisfies file-over-app without contorting the editing model.
10. **Permissions, when they come, live outside the merged document** (per-space ACL, server- or consensus-validated), keyed off the `parentId` spine.

### "Cheap now, priceless later" — the day-one checklist

- **Stable unique block IDs** (UUIDv4/nanoid), client-generated at creation, never reused, never derived from content or position. *(Cost: one line. Buys: CRDT identity, sync, links, comments, native addressing.)*
- **Parent + ordered-children representation**: `children: BlockId[]` + redundant `parentId`; ordering intent expressed as "after sibling X", never index N; fractional keys only as a private SQLite ordering detail (arbitrary-precision strings). *(Buys: movable-tree upgrade, partial loading, permission spine.)*
- **No index/DOM positions in anything persisted**: selections, comments, deep links anchor to `(blockId, stable sub-anchor)`. *(Buys: every future concurrency feature; Yjs relative positions are the proof.)*
- **Operation-shaped mutations**: one reducer, closed op vocabulary including first-class `move`; ops are serializable and invertible. *(Buys: undo, extension API, audit log, and the entire CRDT retrofit surface.)*
- **Rich text as runs + typed mark spans with declared expansion semantics**, never markup strings. *(Buys: Peritext-grade merging, native AttributedString rendering.)*
- **`schemaVersion` per document + additive-only evolution + unknown-type/field preservation.** *(Buys: mixed-version collaboration, plugin blocks, decade-scale files.)*
- **Ephemeral state (presence, selection) architecturally separated from document state.** *(Buys: clean awareness channel later, no garbage in files now.)*
- **Document = unit of load and sync; workspace = collection of documents.** *(Buys: partial sync, memory bounds, Automerge-Repo-style management.)*

---

## Sources

- [Yjs docs: Relative Positions](https://docs.yjs.dev/api/relative-positions)
- [y-prosemirror (GitHub)](https://github.com/yjs/y-prosemirror) · [Issue #85: awareness loop on shared XmlFragment](https://github.com/yjs/y-prosemirror/issues/85)
- [Yjs releases (v14 RCs, AttributionManager)](https://github.com/yjs/yjs/releases) · [Gutenberg issue #77004: upgrade Yjs to v14](https://github.com/WordPress/gutenberg/issues/77004)
- [y-webrtc issue #43: public signaling servers down?](https://github.com/yjs/y-webrtc/issues/43)
- [Automerge 3.0 announcement](https://automerge.org/blog/automerge-3/) · [Automerge-Repo announcement](https://automerge.org/blog/automerge-repo/) · [Automerge networking docs](https://automerge.org/docs/reference/repositories/networking/) · [Automerge storage docs](https://automerge.org/docs/reference/repositories/storage/) · [automerge/automerge (GitHub)](https://github.com/automerge/automerge)
- [Loro](https://loro.dev/) · [Loro 1.0](https://loro.dev/blog/v1.0) · [Loro: Movable tree CRDTs](https://loro.dev/blog/movable-tree) · [Loro JS/WASM benchmarks](https://loro.dev/docs/performance) · [loro-crdt (npm)](https://www.npmjs.com/package/loro-crdt) · [loro-swift (GitHub)](https://github.com/loro-dev/loro-swift) · [loro-ffi (GitHub)](https://github.com/loro-dev/loro-ffi) · [HN: Movable tree CRDTs and Loro's implementation](https://news.ycombinator.com/item?id=41099901)
- [PkgPulse: Yjs vs Automerge vs Loro (2026)](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026) · [Velt: Best CRDT libraries (updated July 2026)](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)
- [Peritext essay (Ink & Switch)](https://www.inkandswitch.com/peritext/) · [Peritext paper (CSCW 2022)](https://dl.acm.org/doi/abs/10.1145/3555644) · [inkandswitch/peritext (GitHub)](https://github.com/inkandswitch/peritext) · [peritext#31: CRDT-agnostic Peritext](https://github.com/inkandswitch/peritext/issues/31)
- [Kleppmann: Moving Elements in List CRDTs (PaPoC 2020)](https://martin.kleppmann.com/papers/list-move-papoc20.pdf) · [Tree-move publication page](https://martin.kleppmann.com/2020/04/27/papoc-list-move.html) · [CRDTs: The Hard Parts (talk)](https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html) · [Extending JSON CRDTs with Move Operations (PaPoC 2024)](https://arxiv.org/pdf/2311.14007)
- [Figma: Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/) · [Figma: How multiplayer works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) · [Evan Wallace: CRDT Fractional Indexing](https://madebyevan.com/algos/crdt-fractional-indexing/) · [Liveblocks: fractional indexing in sync engines](https://liveblocks.io/blog/how-crdts-and-sync-engines-keep-realtime-lists-ordered-with-fractional-indexing) · [Bartosz Sypytkowski: Non-interleaving LSeq](https://www.bartoszsypytkowski.com/non-interleaving-lseq/)
- [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/) · [Steph Ango: File over app](https://stephango.com/file-over-app)
- [Cambria (Ink & Switch essay)](https://www.inkandswitch.com/cambria/) · [cambria-project (GitHub)](https://github.com/inkandswitch/cambria-project) · [Cambria paper (PaPoC 2021)](https://dl.acm.org/doi/abs/10.1145/3447865.3457963)
- [iroh (GitHub)](https://github.com/n0-computer/iroh) · [iroh FAQ](https://docs.iroh.computer/about/faq) · [TechTimes: iroh 1.0 ships](https://www.techtimes.com/articles/318490/20260616/peer-peer-library-iroh-10-ships-dial-devices-key-not-ip-address.htm)
- [BlogGeek: WebRTC P2P mesh and why it can't scale](https://bloggeek.me/webrtc-p2p-mesh/amp/)
- [BlockSuite overview](https://blocksuite.io/blocksuite-overview.html) · [toeverything/blocksuite (GitHub)](https://github.com/toeverything/blocksuite) · [AFFiNE: What happens after you press A](https://affine.pro/blog/what-happens-after-you-press-a-in-a-collaborative-editor-data-model) · [AFFiNE docs: block model](https://docs.affine.pro/blocksuite-wip/store/block-model) · [AFFiNE docs: block reactive](https://docs.affine.pro/blocksuite-wip/store/block-reactive) · [DeepWiki: BlockSuite editor system](https://deepwiki.com/toeverything/AFFiNE/2.2-blocksuite-editor-system)
- [anyproto/any-sync (GitHub)](https://github.com/anyproto/any-sync)
- [DeepWiki: SiYuan overview](https://deepwiki.com/siyuan-note/siyuan/1-overview) · [siyuan#13065: reduce sync conflicts](https://github.com/siyuan-note/siyuan/issues/13065) · [better-sync-siyuan](https://github.com/DD3Boh/better-sync-siyuan)
- [Notion: The data model behind Notion](https://www.notion.com/blog/data-model-behind-notion) · [Notion: How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline) · [Notion: WASM SQLite in the browser](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) · [TechCrunch: Notion offline](https://techcrunch.com/2025/08/20/finally-notion-now-works-without-an-internet-connection/)
- [App Stacks: Craft](https://appstacks.club/craft) · [Craft (App Store)](https://apps.apple.com/us/app/craft-write-docs-ai-editing/id1487937127)
- [Axiom: TextKit 2 reference (WWDC 2025/2026 sessions)](https://charleswiltgen.github.io/Axiom/reference/textkit-ref) · [Michael Tsai: TextKit 2 — The Promised Land](https://mjtsai.com/blog/2025/08/15/textkit-2-the-promised-land/) · [RichTextKit](https://swiftpackageindex.com/danielsaidi/RichTextKit)
