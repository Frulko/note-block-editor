# Where to pick this up

Written 2026-08-08 at the end of a long session, so the next one starts from
the state rather than re-deriving it. Everything here is measured, not
remembered.

## Where things stand

| Suite | State |
| --- | --- |
| Unit (`pnpm test`) | 851 passing, 66 files |
| Browser, Chromium (`pnpm e2e --project=chromium`) | 116/116, **gates CI** |
| Browser, single-host (`TOPOLOGY=single-host pnpm e2e`) | 111/111, **gates CI** |
| Browser, WebKit (`pnpm e2e --project=webkit`) | 108/108, 8 skipped, **gates CI** |
| Touch, mobile viewports (`--project=mobile-safari --project=mobile-chrome`) | 6+7 passing, **gates CI** |
| Swift (`cd native/swift && swift test`) | 49 passing |
| `pnpm typecheck` | clean, and now covers `apps/` |

Three clients share one document, proven end to end: a keystroke typed into an
`NSTextView` in Swift merges into a TypeScript peer, and a desktop snapshot
reopened in a new process converges with a browser holding nothing.

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
