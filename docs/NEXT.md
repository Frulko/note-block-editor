# Where to pick this up

Written 2026-08-08 at the end of a long session, so the next one starts from
the state rather than re-deriving it. Everything here is measured, not
remembered.

## Where things stand

| Suite | State |
| --- | --- |
| Unit (`pnpm test`) | 845 passing, 65 files |
| Browser, Chromium (`pnpm e2e --project=chromium`) | 116/116, **gates CI** |
| Browser, single-host (`TOPOLOGY=single-host pnpm e2e`) | 111/111, **gates CI** |
| Browser, WebKit (`pnpm e2e --project=webkit`) | 105 passed, 3 failed, 8 skipped, informational |
| Swift (`cd native/swift && swift test`) | 49 passing |
| `pnpm typecheck` | clean, and now covers `apps/` |

Three clients share one document, proven end to end: a keystroke typed into an
`NSTextView` in Swift merges into a TypeScript peer, and a desktop snapshot
reopened in a new process converges with a browser holding nothing.

## The three open WebKit failures

Each has been diagnosed to a different depth. None is a mystery; all need a
session with room to verify properly.

**1. `gutter.spec.ts` — the gutter does not follow the scroll.**
Diagnosed. Both engines lay the document out *identically* (fifty blocks, an
editor 1764px tall inside a 720px window), so the page never scrolls in either
— the editor's own container does. Chromium delivers `mouse.wheel` to the
hovered scrollable element; WebKit does not.

> **The trap, learned the hard way.** Scrolling the container directly instead
> passed when the file ran alone and failed on *both* engines in the full
> parallel run. That trades a known failure for a flaky one, which is worse,
> and it was reverted. **Verify any replacement in a full run.**

**2 and 3. `assets.spec.ts` — the helper hangs on `indexedDB.open`.**
Dug one level. The helper forced version `1`, which requests an upgrade
whenever the app already opened the database higher, and an upgrade blocks
while the app holds its connection — with `onblocked` unhandled the promise
never settled. That is fixed (no forced version, `onblocked` rejects loudly)
and Chromium passes. **WebKit still hangs, and not through `onblocked`**: the
request fires none of success, error or blocked.

Start by checking whether the demo's own IndexedDB connection is open at that
moment, and whether WebKit's stricter storage partitioning under Playwright is
involved.

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
