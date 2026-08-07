# Where to pick this up

Written 2026-08-08 at the end of a long session, so the next one starts from
the state rather than re-deriving it. Everything here is measured, not
remembered.

## Where things stand

| Suite | State |
| --- | --- |
| Unit (`pnpm test`) | 846 passing, 65 files |
| Browser, Chromium (`pnpm e2e --project=chromium`) | 116/116, **gates CI** |
| Browser, single-host (`TOPOLOGY=single-host pnpm e2e`) | 111/111, **gates CI** |
| Browser, WebKit (`pnpm e2e --project=webkit`) | 107 passed, **1** failed, 8 skipped, informational |
| Swift (`cd native/swift && swift test`) | 49 passing |
| `pnpm typecheck` | clean, and now covers `apps/` |

Three clients share one document, proven end to end: a keystroke typed into an
`NSTextView` in Swift merges into a TypeScript peer, and a desktop snapshot
reopened in a new process converges with a browser holding nothing.

## The one open WebKit failure

Two of the original four were closed on the way out. One was a test that
cannot be expressed on WebKit at all (`Input.dispatchTouchEvent` is CDP), and
two were a **real product bug**: WebKit's IndexedDB refuses a `Blob` value, so
every image would have silently failed to persist on Safari and iOS. That is
what the WebKit run was for, and it paid for itself the first day.

**1. `gutter.spec.ts` — the gutter does not follow the scroll.**
Do not start by fixing this. Start by working out what the test measures,
because the last measurement says it is not what the name claims.

Established, in this order:

- Both engines lay the document out *identically* — fifty blocks, an editor
  1764px tall inside a 720px window — so the page itself never scrolls in
  either. My first conclusion was that Chromium delivers `mouse.wheel` to the
  hovered scrollable element and WebKit does not.
- **That was wrong too.** A probe of `mouse.wheel(0, 300)` shows `scrollTop`
  unchanged at `0` on `.nbe-editor`, `document.scrollingElement` *and*
  `document.body`, **on both engines**. Nothing among the three obvious
  containers moves anywhere.
- Yet on Chromium the test passes: the gutter's `top` drops by more than 100px
  while staying beside the same block at the same offset. So something moves
  it, and it is not any scroll this probe can see.

The first job is therefore to find what actually moves the gutter on Chromium.
Until that is known, any "fix" is a guess dressed as a repair — and one such
guess has already been reverted here (it passed when the file ran alone and
failed on both engines in the full parallel run, trading a known failure for a
flaky one). **Verify anything in a full parallel run, never in isolation.**

**And a lesson about diagnosing.** I first concluded the asset tests were
hanging on a blocked `indexedDB.open` and wrote that here as fact. A three-line
probe showed `open` succeeding and the *write* failing. The moral is cheap and
worth repeating: probe before recording a cause, especially when the cause is
about to become someone else's starting point.

## What needs something this machine does not have

- **An Android device and an iPhone.** WebKit covers Safari's *engine*, which
  is most of what a cross-browser editor gets wrong — but not the input stack:
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
