# Manual test matrix — IME, keyboards, screen readers

The parts of the editor no CI can verify (AQ#6: CDP cannot synthesize real IME
composition, and screen-reader behavior only exists on real assistive tech).
This is the executable protocol; run it before any release that touches
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
Escape cancelling a drag, the side drop building columns, `columns: false`
reordering instead, and the whole block-mode key contract (Escape, arrows,
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

First run: **105 passed, 4 failed, 7 skipped.** Run it with
`npx playwright test --project=webkit`.

### Skipped by necessity

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
2. **`assets.spec.ts` ×2 — the helper hangs on `indexedDB.open`.** Investigated
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
