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

## Regression checklist per run

- [ ] All IME scenarios on devices 4–10
- [ ] AZERTY scenarios on devices 1–3
- [ ] SR scripts (VoiceOver, NVDA)
- [ ] Paste from Word + Google Docs on devices 1–2 (fixtures cover parsing;
      this verifies the clipboard formats actually arriving)
- [ ] Results recorded below

## Results log

| Date | Commit | Matrix rows run | Failures | Notes |
|------|--------|-----------------|----------|-------|
| —    | —      | not yet run — needs real hardware | — | first pass pending |
