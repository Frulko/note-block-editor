# Where to pick this up

Written 2026-08-08 at the end of a long session, so the next one starts from
the state rather than re-deriving it. Everything here is measured, not
remembered.

## Where things stand

| Suite | State |
| --- | --- |
| Unit (`pnpm test`) | 1012 passing, 87 files |
| Browser, Chromium (`pnpm e2e --project=chromium`) | 189/189, **gates CI** |
| Browser, single-host (`TOPOLOGY=single-host pnpm e2e`) | 184/184, 5 skipped, **gates CI** |
| Browser, WebKit (`pnpm e2e --project=webkit`) | 178/178, 11 skipped, **gates CI** |
| Touch, mobile viewports (`--project=mobile-safari --project=mobile-chrome`) | 6+7 passing, **gates CI** |
| Performance (`e2e/performance.spec.ts`) | keystroke 8.3ms / 8.4ms at 500 blocks, render 205ms |
| Swift (`cd native/swift && swift test`) | 75 passing |
| iOS UI (`cd apps/ios && xcodebuild test …`) | 16/18; the two that type words are keyboard-flaky, `docs/TESTING.md` |
| `pnpm typecheck` | clean, and now covers `apps/` |

Three clients share one document, proven end to end: a keystroke typed into an
`NSTextView` in Swift merges into a TypeScript peer, and a desktop snapshot
reopened in a new process converges with a browser holding nothing.

**And now with no server in the path.** Typed in Chrome, read on an iPhone in the
simulator, stored to disk by `nbe peer` — three peers, three languages, a full
WebRTC mesh, and the relay watching none of it go by. Run it: `apps/ios/README.md`.

## Comments are a discussion, 2026-08-09

Reported as a rendering fault — the marker on a commented block and the hover
gutter's comment button drawn one over the other — and it was, but the drawing
was the smaller half of it.

- **One bubble in that margin.** They were never two affordances: both mean
  "talk about this block". The marker takes the gutter button's geometry
  (26px, right edge at `rect.right + 32`) and `controls.ts` drops the hover one
  on a block that has `data-comments`. A host's own right-gutter actions still
  show.
- **`openCommentThread` in `@nbe/dom`.** Three hosts had each written the same
  composer and each had written it badly in a different way: the site's
  playground asked in a `prompt()`, the Obsidian plugin packed the discussion
  so far into the textarea's *placeholder*, and none of the three could show a
  reply or take a comment back — every click started a new thread. It is one
  part now, exported the way `createPopover` is: messages down the panel, a
  field at the bottom, a bin on each message, resolve per thread. `onComment`
  is unchanged — the editor still contributes the affordance and not the
  layout, it just ships the usual bubble for hosts that want it.
- **`CommentStore.deleteMessage`.** "Delete this comment" has to be able to
  mean one reply. The last message takes its thread with it, in both stores.
- **Deleting a thread lifts its anchor** (`removeCommentThread`). This was a
  live bug in every host: the margin counts `comment` marks, so a thread
  deleted from a panel left the block wearing a badge that opened onto nothing.
- `commentPlaceholder`/`commentReply`/`commentSend`/`commentDelete`/
  `commentResolve`/`commentReopen`/`commentAnonymous` in all five dictionaries,
  plus `CommentThreadOptions.locale` — a dictionary is not a locale and `Intl`
  needs a tag, which is why the demo's French panel was dating messages in
  English.

`e2e/comment-bubble.spec.ts` covers the single bubble, the reply joining its
thread, reopening, and the delete taking the marker with it.

## The colours were never repainted, 2026-08-09

Reported as "the code block's highlighting breaks the moment you edit, and only
a reload brings it back". It was, and the code block was the messenger: the bug
was in `EditorView`'s listener order and it silently affected everything that
measures the DOM.

- **The view now listens before the features it renders for.** `Editor.emit`
  calls listeners in registration order and the view registered *last*, so every
  feature ran against the DOM the re-render was about to replace. Three had each
  grown their own `queueMicrotask` to step around it (`comment-marker`,
  `word-count`, mermaid's panel); the ones that had not — syntax colours, the
  cross-block selection, a peer's caret, a table's cell selection — just stopped
  painting after the first keystroke. Two lines moved in the constructor.
- **Why no test caught it.** A `Range` is not invalidated when its text node is
  removed: the DOM's removing steps re-point it at the surviving parent. So the
  registry stayed full, `Highlight.size` kept counting, `isConnected` kept
  answering yes, and not one character was painted — and the spec asserted
  exactly `isConnected`. It asks the right question now (is the boundary a text
  node *inside the leaf*), and fails on the old code.
- **`EditorView.onRender(cb)`.** Because ordering is only half of it: a render
  can have no transaction behind it at all — a peer's edit arriving through
  `renderAll` (`redrawOnRemote`), a composition paid back when the IME commits,
  foreign markup reverted by the observer. `editor.on` never saw those, so a
  collaborator's keystroke used to take your syntax colours with it. The
  callback gets the blocks whose elements were replaced, or `null` for the whole
  surface, and `@nbe/blocks-code` measures there instead of on the change.
- **The hover toolbar sits above a code block now**, like a table's. A code
  block's top-right corner is not spare room: the bar was drawn over the
  language badge and the first line of code, so reaching for Copy hid what you
  were copying.

Still on `editor.on` and still blind to a transaction-less render: `search.ts`,
`remote-carets.ts`, `cross-block-highlight.ts`, `blocks-table/select.ts`. The
ordering fix covers the common case for all four; moving them onto `onRender` is
the same three-line change each, when someone reports it.

## Comfort pass, 2026-08-09

Eight items off `Amélioration de Carnet.md`, each its own commit, each with the
spec that failed before it. Grouped by what they turned out to *be*, because in
every case the reported symptom was not the bug:

- **`a06ca34` — the standard editing keymap.** macOS gives Control its own text
  keymap (`^A`/`^E`/`^K`/`^F`/`^B`/`^N`/`^P`/`^D`) and every browser implements
  it inside a contenteditable; reading Control as the command modifier stole all
  of them. `isMod` splits them. Word and line deletes (`⌥⌫`, `⌥⌦`, `^K`) fell
  through `beforeinput`'s default arm and were blocked outright — and Chromium
  reports **zero** `getTargetRanges()` for those input types, measured, so
  `prevWord`/`nextWord` compute the boundary from UAX #29. Also `⌘⌫` deletes the
  block, and clicking the empty page below the last block works: the gesture
  router marked a press "moved" at one pixel of drift and swallowed the click.
- **`03266f9` — `reveal()`.** `Element.scrollIntoView` scrolls *every* scrollable
  ancestor. Inside Obsidian's pane, inside a workspace, inside a window, that is
  a keystroke moving something far above the editor. Asking first costs one rect
  read.
- **`d110c40` — Obsidian tooltips were black on black.** The plugin sheet
  repaints portaled chrome with the page's ink and listed the surfaces it must
  not reach; the tooltip was missing from the list. `test/design.test.ts` now
  derives that list from the stylesheets.
- **`e4dcbda`** — `⌥↑`/`⌥↓` moves a block, `⇧⌥↑`/`⇧⌥↓` copies it.
- **`2dfa6bb` — checklists.** `- ` made the block a bullet before `[ ] ` arrived,
  and autoformat only ran on paragraphs, so the Markdown spelling of a checklist
  never made one. `⌘Enter` ticks. `+` is a bullet marker. Brackets are escaped
  only where they would parse back as a link.
- **`79488e3` — `@nbe/blocks-toc`.** The first block whose content *is* the
  document, which needed `ProjectionContext.page` (a projection rendering one
  block cannot look sideways) and a feature rather than a render hook (typing in
  a heading dirties the heading). It found two general bugs: a void block from
  the slash menu left nowhere to type, and slash results were in registration
  order so `/table` reached the wrong entry.
- **`0814c83`** — a theme choice in Obsidian's settings and the desktop topbar.
- **`cdfba11` — superscript, subscript, `==highlight==`.** And the bug under
  them: **underline never round-tripped.** `<u>x</u>` had been written since day
  one and never read back.

What is left on that list and still cheap: inline comments with a count badge in
the gutter (needs a `commentCount` host hook — the threads are the host's), page
icon/tags/cover, the live/raw toggle, PDF/LaTeX export. The code-block items
(tab handling, the language input losing focus, syntax highlighting) are done —
the last of them is the section above.

## Peer-to-peer, 2026-08-08

The question was "any-sync's p2p tooling — we want a fully p2p WebRTC system,
no?". The answer to the second half is **no, and neither does any-sync**, which
is the useful part: `docs/research/p2p-any-sync.md` has what its code actually
says (yamux, QUIC, WebTransport, no WebRTC, no NAT traversal, mDNS in the client
and an always-on node off the LAN) and D9 in `ARCHITECTURE.md` has the decision.

What shipped, and the shape is one sentence: **the relay signals, then gets out
of the way, and is also the fallback.**

- **`packages/collab/src/webrtc.ts`** — `p2pTransport(signalling, opts)` wraps
  any transport and returns one, so `connect()` never learns it went direct.
  `Message.Signal = 3` rides the relay room, which was already a broadcast bus,
  so **the relay needed no signalling server** — only the membership count,
  which is the one fact peers cannot learn by themselves.
- **`nbe peer`** — a headless WebRTC client, `node-datachannel` for the
  `RTCPeerConnection` Node lacks. The dependency lives in the CLI, not in
  `collab`, which stays at core+CRDT.
- **`apps/ios`** — SwiftUI, xcodegen, real Google WebRTC. The protocol is in
  `native/swift` (`SyncSession`, `P2PTransport`, `RelayTransport`) and injects
  its `PeerLink`, so `swift test` checks the state machine without downloading a
  40MB binary. One file in the app imports WebRTC.

## The iOS app is an editor now, 2026-08-08 (later)

The first version was a sync proof with a `TextField` per block — no commands, no
drag, unusable as an editor, and correctly called out as such. What it is now:

- **A `UITextView` per block** (`BlockTextEditor`), because SwiftUI's text
  controls cannot report Backspace-at-0 or intercept Return, which is most of
  what makes a block editor one. UIKit sibling of the AppKit `BlockTextView`.
- **The structural commands live in `native/swift`** — `splitBlock`,
  `mergeBackward`, `turnInto`, `indent`, `outdent`, `move`, `setProp` on
  `DocumentWriter`, mirrored from `packages/core/src/commands.ts` line for line
  and covered by 23 new tests. Enter on an empty bullet stops being a bullet;
  Backspace at the start of a heading makes it a paragraph first; Tab under the
  first sibling refuses. A split **keeps the marks on both halves**, because
  reading the plain string back would silently strip a link off every peer's copy.
- **`Autoformat` moved to `NbeModel`** and `test/swift-parity.test.ts` fails if
  the two tables drift — the exact bug a second implementation produces, where
  both sides work and the same keystroke does two things.
- **The slash menu, markdown prefixes, checkboxes, indent/outdent, reorder, a
  keyboard bar**, and drag handles. The bar is the phone's answer to Tab, and its
  up/down buttons are not a test affordance: dragging a block past a screenful is
  miserable, and a VoiceOver user cannot drag at all.
- **`Offsets` gained the CRDT's unit.** Three now coexist — UTF-16 for the model,
  grapheme clusters for Swift, code points for Loro — and a test pins Loro's with
  a document rather than trusting a comment, because getting it wrong tears text
  around an emoji.

**Eight bugs came out of driving the keystrokes**, every one invisible from the
document: see `docs/TESTING.md`. The one worth repeating is the last: a view being
asked whether it may accept a character *is* the first responder, and comparing
that against published state that lags a frame is how a tap-then-type lost its
first letters.

**Where it stops.** Two UI checks fail in the full run and pass alone, and the
cause is iOS's own suggestion bar rewriting words and taking Return — a driven
sentence is not the same input twice. That is the boundary where synthetic typing
stops being evidence, and the honest next step is a device, not another patch.
- **Desktop and the web demo** show which path is live, because an optimisation
  nobody can observe is one nobody can debug.

**The trap, written down because it is silent:** a peer that cannot speak WebRTC
never says hello, so peers counting greetings would mesh, stop using the relay,
and leave `nbe serve` receiving nothing while every screen looked healthy. Both
implementations take the count from the relay, and both have the test.

**What is still not proven:** a network where the direct path *fails*. The
simulator shares the Mac's stack and CI is a loopback, so every mesh here
succeeded. The fallback is exercised (the third test in each file), the NAT that
would force it is not.

## Shipped earlier, 2026-08-08

- **Both hover gutters are configurable lists** (`EditorViewOptions.gutter`).
  `'add' | 'handle' | 'comment'` are named built-ins a host can reorder or
  drop, alongside its own `GutterAction`s. The right-hand one is new and holds
  the comment button, which is not rendered at all without an `onComment` host
  rather than rendered dead.
- **Comments are on blocks**, from that button. The anchor is still the mark
  §2.2 documents, laid over the block's whole text; `commentAuthor` is optional
  and anonymous is a real mode, not a degraded one.
- **Side drops are off by default** and marked experimental
  (`columns`, was `true`). A drag now has one meaning. `?columns=on` in the
  demo, and the e2e describes swapped accordingly.
- **The collab demo joins a real relay** with `?room=<nom>`: `nbe relay` or
  `nbe serve`, several browsers, named carets. Verified across two browsers,
  not only in the loopback.
- **`Editor` and `EditorView` are documented at the class level**, so TypeDoc
  stops excluding them and the generated reference finally carries the
  constructor, the methods and the event surface. `site/src/lib/api.ts` learned
  constructors and accessors; new pages: `/docs/examples/`, `/docs/markdown/`,
  `/docs/hosts/`, `/docs/api/editor/`.

## WebKit: closed

All four original differences are gone. Two were tests that cannot exist there
(CDP), one was a real product bug (WebKit's IndexedDB refuses a `Blob`, so every
image would have silently failed to persist on Safari and iOS), and the last
was a product *decision* Chromium had been hiding:

The gutter used to stay welded to the block it opened on and ride it out of the
viewport — measured at `top: -82` after 300px of scroll, above the screen,
decorating nothing. WebKit re-fires the hover on a programmatic scroll and
Chromium does not, so only WebKit's test caught it. The editor now re-answers
the hover on scroll itself, so on both engines the gutter stays beside the block
you are pointing at. The test asserted the old behaviour and now asserts the
intended one.

Five hypotheses were measured and killed before that one held: wheel delivery,
layout, the portal, `autoUpdate`, and finally the re-hover. **Verify anything
here in a full parallel run, never in isolation** — an earlier fix passed alone
and failed on both engines in the full run.

## What needs something this machine does not have

- **An Android device and an iPhone**, and this is now a narrow ask rather than
  a broad one. Three things that looked like "needs hardware" turned out to be
  two things each, and the reachable half of every one is done: the *engine* is
  covered by WebKit, *touch and viewport* by the mobile projects, and the
  software keyboard's *effect* by `packages/dom/test/viewport.test.ts`, which
  simulates the `visualViewport` shrink the keyboard causes.

  What is genuinely left has no simulable half:
  the software keyboard, touch selection, and a particular IME's behaviour
  (GBoard actively lies about `beforeinput`). This is **the decisive question**,
  not a residual one: see `docs/research/per-block-contenteditable-evidence.md`.
  If per-block `contenteditable` fails there, the switch is now a flag —
  `singleHostTopology` passes 111/111 and gates CI. It did not when this session
  started; twelve tests failed and nobody had ever run them.
- **A licence and a repository URL.** One command, and it is the owner's:
  `node scripts/set-licence.mjs MIT https://github.com/…`. The evidence and a
  recommendation are in `docs/design/licence.md`. The script refuses to run
  without both, on purpose.

## Two habits this session earned

**Run the alternative, don't claim it.** The roadmap said switching topology
was "a config change". It was not — the claim rested on a unit suite while the
end-to-end suite had never been pointed at it. Running it found twelve
failures, two root causes, and one genuine bug (pointer capture silently
disabling native drag-select). It is true now *because* it is gated.

**A second implementation finds the first one's blind spots.** Guarding Swift
against writing marked text mid-composition led directly to finding the mirror
bug on the web side: a remote edit reaching `renderAll` from the network would
rebuild the DOM under a half-typed word. Neither would have been found from
inside its own language.
