# Where to pick this up

Written 2026-08-08 at the end of a long session, so the next one starts from
the state rather than re-deriving it. Everything here is measured, not
remembered.

## Where things stand

| Suite | State |
| --- | --- |
| Unit (`pnpm test`) | 917 passing, 80 files |
| Browser, Chromium (`pnpm e2e --project=chromium`) | 137/137, **gates CI** |
| Browser, single-host (`TOPOLOGY=single-host pnpm e2e`) | 132/132, 5 skipped, **gates CI** |
| Browser, WebKit (`pnpm e2e --project=webkit`) | 127/127, 10 skipped, **gates CI** |
| Touch, mobile viewports (`--project=mobile-safari --project=mobile-chrome`) | 6+7 passing, **gates CI** |
| Performance (`e2e/performance.spec.ts`) | keystroke 8.3ms / 8.4ms at 500 blocks, render 205ms |
| Swift (`cd native/swift && swift test`) | 52 passing |
| iOS app (`cd apps/ios && xcodegen generate && xcodebuild …`) | builds and runs in the simulator |
| `pnpm typecheck` | clean, and now covers `apps/` |

Three clients share one document, proven end to end: a keystroke typed into an
`NSTextView` in Swift merges into a TypeScript peer, and a desktop snapshot
reopened in a new process converges with a browser holding nothing.

**And now with no server in the path.** Typed in Chrome, read on an iPhone in the
simulator, stored to disk by `nbe peer` — three peers, three languages, a full
WebRTC mesh, and the relay watching none of it go by. Run it: `apps/ios/README.md`.

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
