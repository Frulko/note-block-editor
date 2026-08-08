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

## The one open WebKit failure — investigated to a decision

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

- **Then measured properly, and it is a product difference.** The scrolling
  element is `DIV.page-scroll` — a demo container neither earlier probe checked.
  On Chromium `mouse.wheel` moves it 300px; the gutter is `position: absolute`
  *inside* it, so its `style.top` stays at `141px` while its viewport position
  goes 218 → −82. It travels with the content, which is what the test means.
- The test now scrolls `.page-scroll` directly, which is deterministic and
  passes on Chromium in full runs. **On WebKit the gutter still does not move**
  — 218 before and after — so the remaining failure is real: under WebKit the
  gutter does not travel with the scrolled content.

- **Portal hypothesis: disproved.** The ancestry is identical on both engines —
  `.nbe-controls` → `.nbe-editor` → `.page` → `.page-scroll` → `main.layout`.
  The gutter is inside the scroller in both.
- **Layout hypothesis: disproved.** `.page-scroll` scrolls identically on both:
  `scrollTop` 0 → 300, `clientHeight` 673, `scrollHeight` 1794, `overflow-y:
  auto`. The browser does the same thing in both engines.

**So the difference is in our own positioning code, not in the browser.** The
DOM is the same, the scroll is the same, and the element is inside the thing
that scrolled — yet on Chromium its `style.top` stays at `141px` while it
travels with the content, and on WebKit it stays visually put at `218`. The
shape of that says something re-writes `style.top` on scroll under WebKit and
not under Chromium.

- **`autoUpdate` hypothesis: disproved too.** The gutter does not use it.
  `showControlsFor` in `controls.ts` positions it *once*, on hover, inside
  `view.content` via `toContainerPoint` — so it is absolutely positioned within
  the scrolled container and travels with the content for free. Nothing
  re-writes `style.top` on scroll by design.

**Confirmed, and it is not a test bug — it is a product question.** Measured
after a 300px scroll under a stationary pointer:

| | `style.top` | screen `top` | block beside it |
| --- | --- | --- | --- |
| Chromium | `141px` (unchanged) | 218 → **−82** | "ligne 3" → *off-screen* |
| WebKit | `141px` → **`441px`** | 218 → 218 | "ligne 3" → **"ligne 13"** |

WebKit re-fires the hover on a programmatic scroll; Chromium does not. So
`showControlsFor` runs again on WebKit for the block now under the cursor, and
the gutter stays beside the pointer.

**WebKit's behaviour is the better one.** The gutter belongs to the block you
are pointing at. Chromium leaves it attached to a block that has scrolled away
— at `−82`, above the viewport, decorating nothing.

So the open item is a decision, not a defect hunt:

1. **Adopt WebKit's behaviour** — reposition the gutter on scroll for the block
   actually under the pointer, on both engines. Correct, and makes the test's
   current assertion (`top` decreases, same block) wrong: it should assert the
   gutter stays beside *whatever* is under the cursor.
2. **Keep Chromium's** — hide the gutter on scroll instead, since a gutter
   pointing at nothing is worse than no gutter.

Either way `controls.ts` changes and so does the test. Option 1 is more work
and is what a reader would expect. Do not "fix the WebKit failure" — decide
first.

**And the standing rule, learned twice here.** An earlier fix scrolled
`.nbe-editor` with a fallback to the document — neither of the elements
involved — and was flaky for that reason. **Verify anything in a full parallel
run, never in isolation.**

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
