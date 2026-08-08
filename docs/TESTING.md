# What needs a device, and what turned out not to

**Corrected 2026-08-08.** This document used to open by saying CDP cannot
synthesize real IME composition. **It can** — `Input.imeSetComposition` drives
Chromium's genuine pipeline, and AppKit's `NSTextInputClient` is callable
directly from a Swift test. Both were used this week and both found real bugs:
composing a word wrote three intermediate states into the CRDT and broadcast
each to every peer, and a remote edit arriving mid-composition rebuilt the DOM
under a half-typed word.

That correction matters beyond the fact, because "no CI can verify this" is a
claim that stops people trying. The honest line is narrower:

**Automated, and gating** (see the sections below): composition handling on two
platforms, the clipboard, drag, four browser projects including Safari's engine,
touch at phone viewports, and the software keyboard's *effect* on the viewport.

**Still needs a device, and nothing simulates it:** a *particular* IME's
behaviour — Android GBoard actively lies about `beforeinput`, a Chinese IME has
a candidate window, Korean composes jamo — plus the software keyboard's own
input stack, physical non-US layouts with dead keys, and screen readers, which
exist only on real assistive tech.

The matrix below is that residue. Run it before any release touching
`input.ts`, `keymap.ts`, `selection.ts` or `view.ts`, and record results in the
table at the bottom.

## Device / browser matrix

| # | Platform | Browser | Input |
|---|----------|---------|-------|
| 1 | macOS | Chrome | US + AZERTY hardware |
| 2 | macOS | Safari | US + AZERTY hardware |
| 3 | macOS | Firefox | US + AZERTY hardware |
| 4 | Android (mid-range device, not an emulator) | Chrome | GBoard |
| 5 | Android | Chrome | Samsung Keyboard |
| 6 | Android | Chrome | SwiftKey |
| 7 | iOS | Safari | default keyboard |
| 8 | macOS | Chrome | Japanese IME (romaji) |
| 9 | macOS | Chrome | Chinese Pinyin IME |
| 10 | macOS | Safari | Korean 2-set IME |

Never treat one Android keyboard as representative — GBoard, Samsung and
SwiftKey mix cancelable and non-cancelable beforeinput differently
(research: contenteditable-wysiwyg).

## IME / composition scenarios

For each: type in a paragraph containing existing bold text so mark
preservation is visible. **Pass = model text equals visible text, no
duplicated or dropped characters, marks intact around the composition.**

1. **JP conversion**: type `nihongo`, space to convert to 日本語, Enter to
   commit. Then undo — the whole composition must undo as one group.
2. **JP mid-composition escape**: type `kanji`, press Escape mid-composition.
3. **Pinyin multi-candidate**: type `zhongwen`, pick the 2nd candidate.
4. **Korean syllable assembly**: type `dks` (안) then Backspace once —
   should decompose the syllable, not delete it whole.
5. **GBoard word composition**: type an English word letter by letter,
   accept an autocorrect suggestion, then Backspace mid-word (GBoard fires a
   lying insertCompositionText replacing the whole word — CKEditor #12456).
6. **GBoard emoji + ZWJ**: insert 👨‍👩‍👧, Backspace until gone (multiple
   presses acceptable — code-point stepping is the documented ceiling, AQ#4).
7. **Composition at a mark boundary**: caret right after bold text, compose,
   commit — composed text must inherit the bold (marksAt rule).
8. **Composition then immediate Enter**: the split must not duplicate the
   composed text.

## Keyboard-layout scenarios (AZERTY focus)

1. Dead keys: `^` then `e` → ê, in the middle of a word.
2. `Alt+Shift+(` etc. for brackets — no keymap interference (our mod guard
   excludes altKey).
3. Cmd+Z / Cmd+Shift+Z on AZERTY (Z is the same physical key — verify no W
   confusion from code-vs-key handling).
4. Slash menu: `/` is Shift+`:` on AZERTY — menu must open.
5. Markdown autoformat: `#`, `-`, `>` reachable and triggering.

## Screen-reader scripts

**VoiceOver + Safari (macOS)** and **NVDA + Chrome (Windows)**, one pass each:

1. Tab into the editor — exactly one tab stop; the document is announced as
   an editable text region.
2. Read through blocks with SR navigation — every block's text is reachable
   and read in order; the toggle button announces expanded/collapsed.
3. Escape into block-selection mode, arrow between blocks — selection is
   perceivable (aria-live announcements fire on move/type-change/delete).
4. Open the block menu from the handle button (it is focusable and labeled) —
   menu items are announced; every drag operation has a menu equivalent.
5. To-do checkbox: role and checked state announced, toggle works.
6. Slash menu: filtering announces the active option (listbox/option roles).
7. Type, bold a word with Cmd+B, undo — all without sighted assistance.

## Cross-block selection (D3) — the highest-risk surface

The browser will not hold a `Selection` across editing hosts — measured in
Chromium 150/151, `e2e/selection-topology.spec.ts`. So the model carries the
range and the CSS Custom Highlight API paints it (D3, `cross-block-highlight.ts`).
Machine-checkable behaviour lives in `e2e/cross-block-selection.spec.ts`; what
is listed here is what only a human or a real device can judge.

**The known gap, and the reason this section exists.** A `Highlight` is not a
`Selection`. `window.getSelection()` therefore does not report a cross-block
range, and two things follow that no test asserts because they are not ours to
fix: a screen reader does not announce the selection, and browser find-on-page
cannot extend it. Everything the editor itself does — copy, cut, delete, format,
paste-over — goes through the model and is unaffected. Measuring how bad the
announcement gap actually is, on real screen readers, is what open question 9
in `docs/ARCHITECTURE.md` is waiting on.

1. **Desktop, all three engines**: drag from the middle of one paragraph into
   the middle of a paragraph three blocks below. The highlight must be
   continuous and partial at both ends. **Safari paints partial selections
   with a different model — check visually, not just by assertion.**
2. **Firefox**: confirm the selection is partial, not all-or-nothing (old
   Gecko behaviour); confirm a single range is reported.
3. Type over the range, then Backspace over it: both must replace it in one
   undoable step, with the last block's children preserved.
4. Copy a partial cross-block range and paste into a plain text editor — the
   partial ends must be there.
5. **iOS Safari, touch**: try the same drag. Touch drags go through the same
   pointer path, but the OS selection handles do not; record what happens.
6. **Screen readers (VoiceOver, NVDA), both topologies.** Make a cross-block
   selection and ask the reader what is selected. Per-block is expected to say
   nothing useful; `?topology=single-host` is expected to announce it properly.
   This is the measurement open question 9 needs — record both, verbatim.
7. **Find-on-page**: Cmd+F a word inside a cross-block selection. Expected:
   the browser's own highlight appears, ours does not extend. Confirm the two
   do not paint each other into illegibility.
8. IME: start a composition with a cross-block range live.
9. Triple-click a paragraph: the selection must not spill into the next block.

## Block selection and drag (automated since 2026-08-07)

`e2e/block-drag.spec.ts` drives the real pointer over the real editor, because
both faults it was written for were invisible to the model — the document was
fine, the interaction was not. It covers the indicator being a *coloured* line,
the gap between blocks having an answer, vertical reorder in both directions,
Escape cancelling a drag, the far edge reordering by default, `columns: true`
building a column layout instead, and the whole block-mode key contract (Escape, arrows,
Shift+arrows, Backspace, Meta+Shift+arrows).

What still needs hands, on top of the matrix below:

1. **Touch**: long-press to grab, drag with a finger, and whether the
   indicator is visible under the thumb.
2. **Trackpad momentum**: flick-drag past the last block and confirm edge
   auto-scroll stops cleanly rather than running away.
3. **Dark mode**, every floating piece: ghost, indicator, rubber band, menus.
   The token scope reaches them through one marker class now; a portal that
   forgot it will look plausible in light mode and wrong in dark.

## Notion import — the fixtures are second-hand

`packages/workspace/src/notion.ts` reads a Notion Markdown export. Its rules
come from the export shape documented in `docs/research/notion-editor.md` —
`Title <32 hex>.md` filenames, the title repeated as a heading, relative
URL-encoded links, emoji blockquotes for callouts, databases as separate CSVs.

The fixtures in `packages/workspace/test/notion.test.ts` are **constructed from
that description, not captured from a real export**, which needs a Notion
account this project does not have. So the parsing is exercised; the shape is
taken on the research note's word.

What a person with an account should check, once:

1. Run a real export of a workspace with sub-pages, a database, a toggle and a
   callout. Import it. Compare page count, titles and hierarchy.
2. Confirm the filename id really is the page id — re-export after an edit and
   re-import; pages must update, not duplicate.
3. Note what arrives wrong and add it as a fixture before fixing it.

## Touch, on a real device

`e2e/touch.spec.ts` covers what Chromium emulation can honestly cover: the
layout at 390px, drawers, a finger dragging a block, and a 44px tap target.
Emulation gets the *events* right and the engine wrong, so these need hands:

1. **iOS Safari**: place the caret, then check the keyboard does not cover it.
   Then select across two blocks and look for the OS selection handles — a
   painted highlight is not a selection, so they will not appear (question 9).
2. **Android Chrome**: the same, plus the floating "paste" chrome, which
   overlaps our own toolbars.
3. **Long-press** on a block on both: today it opens the browser's own context
   menu rather than grabbing the block. Record what each does before designing
   the gesture.
4. **Pinch-zoom** while the caret is visible: the viewport guard must not
   scroll the page under the gesture.

## Regression checklist per run

- [ ] All IME scenarios on devices 4–10
- [ ] AZERTY scenarios on devices 1–3
- [ ] SR scripts (VoiceOver, NVDA), including cross-block scenario 6
- [ ] Paste from Word + Google Docs on devices 1–2 (fixtures cover parsing;
      this verifies the clipboard formats actually arriving)
- [ ] Drag/selection touch + dark-mode passes (section above)
- [ ] A real Notion export imported at least once per release
- [ ] Touch matrix on one iOS and one Android device
- [ ] Results recorded below

## Results log

| Date | Commit | Matrix rows run | Failures | Notes |
|------|--------|-----------------|----------|-------|
| —    | —      | not yet run — needs real hardware | — | first pass pending |

## WebKit — added 2026-08-08

The suite now runs on WebKit as well as Chromium. WebKit is Safari's engine and
therefore iOS's, and the external evidence on D1
(`docs/research/per-block-contenteditable-evidence.md`) says per-block
`contenteditable` is exactly where Notion hit "roadblocks on iOS and Android".
Running on that engine is the closest this machine gets to the question. It is
**not** a device: the input stack, the software keyboard, touch selection and a
real IME are all still missing.

First run: 105 passed, 4 failed, 7 skipped. **Now 105 passed, 3 failed, 8
skipped** — one "failure" turned out to be a test that cannot be expressed on
WebKit at all. Run it with `npx playwright test --project=webkit`.

### Skipped by necessity

**`e2e/touch.spec.ts`'s handle-drag** uses `Input.dispatchTouchEvent`, a CDP
command. Playwright's own `touchscreen` API covers taps and swipes on every
engine, but a multi-touch *drag* has no cross-engine equivalent. Saying which
kind of gap this is matters more here than anywhere: this suite is the one that
speaks to the mobile question, so a red mark would be read as "touch is broken
on WebKit" when it means "the test cannot be written there".

`e2e/ime.spec.ts` is Chromium-only. `Input.imeSetComposition` is a CDP command
and WebKit exposes no equivalent, so a *genuine* composition cannot be driven
there from a test. What that leaves uncovered is WebKit's particular
composition behaviour, not our handling of composition — the model-side rule is
unit-tested (`packages/dom/test/composition-render.test.ts`) and the Swift side
drives AppKit's own composition protocol directly.

### The four differences, undiagnosed

Recorded rather than fixed, because each needs its own investigation and a
half-fix is worse than a known gap:

1. **`gutter.spec.ts` — the gutter does not follow the scroll.** Diagnosed, not
   fixed. Both engines lay the document out *identically* — fifty blocks, an
   editor 1764px tall inside a 720px window — so the page never scrolls in
   either; the editor's own container does, and Chromium delivers `mouse.wheel`
   to the hovered scrollable element where WebKit does not.
   **An attempt to scroll the container directly instead was reverted**: it
   passed when the file ran alone and failed on *both* engines in the full
   parallel run, so it traded a known failure for a flaky one, which is worse.
   Whatever replaces it has to be verified in a full run, not in isolation.
2. ~~**`assets.spec.ts` ×2**~~ — **fixed, and it was the product, not the
   harness.** My first diagnosis (a blocked `open`) was wrong: a probe showed
   `open` succeeding on WebKit and the *write* failing. See the Blob note
   above. The `open` hardening is kept anyway — forcing a version asks for an
   upgrade that blocks while the app holds its connection, and `onblocked` was
   unhandled. Superseded diagnosis, left here because being wrong in a
   recoverable way is worth recording: Investigated
   one level: the helper forced version `1`, which requests an upgrade whenever
   the app already opened the database at a higher one, and an upgrade blocks
   while the app holds its connection. `onblocked` was unhandled, so the promise
   never settled. Both are fixed — no forced version, `onblocked` rejects loudly
   — and Chromium still passes, but **WebKit still hangs, and not through
   `onblocked`**: the `open` request fires none of success, error or blocked.
   That is a genuine WebKit behaviour and the next person should start by
   checking whether the demo's own IndexedDB connection is open at that moment,
   and whether WebKit's stricter same-origin storage partitioning under
   Playwright is involved.
3. **`touch.spec.ts` — dragging a block by its handle.** WebKit's touch
   emulation differs from Chromium's, and this is the suite that matters most
   for the mobile question, so it deserves the most care and has had none yet.

None is gating yet. They become gating as they are closed, the way the
single-host topology run did.


## Mobile viewports — added 2026-08-08

`--project=mobile-safari` (iPhone 15, WebKit) and `--project=mobile-chrome`
(Pixel 7) run `touch.spec.ts` at phone viewports with touch genuinely enabled.
Both gate CI. Mobile Safari: 6 passed, 1 skipped. Mobile Chrome: 7 passed.

**What this is.** The touch paths — tap to place a caret, the gutter appearing
under a finger, long-press, swipe — exercised at the size they ship at, on the
two engines that matter, rather than only under a desktop mouse.

**What it is not, and this matters.** No software keyboard, no IME, no real
input stack. The D1 question — whether per-block `contenteditable` survives
Android GBoard and iOS Safari — is *not* answered by this and cannot be. What
it does mean is that when a device finally arrives, a failure there is about
the input stack rather than about touch handling or layout, because those are
now under test.

The one skip is the handle-drag, which needs `Input.dispatchTouchEvent` (CDP,
Chromium-only) — so it runs on `mobile-chrome` and not on `mobile-safari`.


## Offline-first, demonstrated — 2026-08-08

`e2e/offline.spec.ts`. The survey names *partial* offline as an anti-pattern
that "invites trust it cannot repay", so the claim is now tested rather than
stated.

- **Zero requests leave the origin.** A remote font, an analytics beacon or a
  CDN script would each break the promise quietly — working in development and
  phoning home in production. The charter names this for fonts specifically:
  Inter is declared and never fetched. Now asserted.
- **The editor works with the network cut.** Typing, editing and the model all
  continue with every request aborted at the browser.
- **And the honest limit, asserted so it cannot drift into an implicit claim:**
  the browser build has **no service worker**, so a genuinely cold start with no
  connection does not work — the page itself is still fetched. The desktop and
  Obsidian builds do not have this limit; their assets are local files. If a
  service worker is ever added, the test that asserts its absence says to delete
  it.

Persistence across reloads is `persistence.spec.ts`'s job and is deliberately
not repeated here — this file's fixture re-seeds its document on every load, so
testing it here would fight the harness rather than the product.


## Peer-to-peer — added 2026-08-08

Three files, and each exists because the other two cannot cover its layer.
The shared idea is that **convergence is not the assertion** — two peers
converge just as well over the relay, so a test that only checked the text
arrived would pass on a design that never went direct. Each one therefore takes
the relay away first.

- **`packages/cli/test/p2p.test.ts`** — real libdatachannel (`node-datachannel`),
  a real relay, and `await relay.close()` in the middle. The edit after that
  can only have crossed the data channel. This is the closest thing to an
  integration test of the whole stack, and it runs in `pnpm test`.
- **`e2e/p2p.spec.ts`** — two browser tabs, Chromium's own ICE agent. Every
  `WebSocket` the page opens is recorded by an init script and closed once the
  mesh is up; the transport deliberately exposes no way to break its socket,
  which is right for the product and inconvenient exactly once, here. Chromium
  only: WebKit's WebRTC wants a capture prompt this cannot answer headlessly,
  and the state machine is covered twice over elsewhere.
- **`native/swift`'s `P2PTests`** — the mesh with a pair of fake `PeerLink`s
  wired to each other, so `swift test` checks who offers, who answers and when
  it is safe to leave the relay without downloading a 40MB WebRTC binary.

**The third test in each file is the one that would have caught the real bug.**
A peer that cannot speak WebRTC never announces itself, so peers counting
greetings mesh, stop using the relay, and leave it receiving nothing — with
every screen still healthy. All three assert that a room holding such a peer
stays on the relay, which is why the relay reports its membership count.

**What none of them cover, and no amount of local testing will:** a network
where the direct path *fails*. Every mesh here succeeds because every peer is on
this machine. The fallback path is exercised; the carrier NAT that forces it is
not. That is the same category as the device matrix above — see
`docs/research/p2p-any-sync.md` for why the fallback is the original transport
rather than a degraded mode, which is what makes the untested case the safe one.
