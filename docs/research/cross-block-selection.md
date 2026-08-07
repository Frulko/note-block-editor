> **Correction, 2026-08-07.** The central claim below — that a DOM Range may
> span several `contenteditable` hosts and the browser paints it — **does not
> hold in Chromium 150 or 151.** Measured with a real browser harness
> (`e2e/selection-topology.spec.ts`): the selection is clamped to the editing
> host it starts in, for `setBaseAndExtent` and `addRange` alike, for
> `plaintext-only` and `true` alike, focused or not. The same range spans when
> the hosts are not editable, and when one editable root holds them.
>
> Either the behaviour changed since this note was written, or the original
> measurement was mistaken. The note is kept because its analysis of the
> *alternatives* — Gutenberg's container toggle, the CSS Custom Highlight
> overlay — remains accurate and is now more relevant, not less. See D3 and
> open question 9 in `docs/ARCHITECTURE.md`.
>
> **What shipped:** the Highlight overlay, in `packages/dom/src/cross-block-highlight.ts`.
> The container toggle was measured too and rejected — both variants (leaves
> made non-editable, and the root made editable, which is Gutenberg's) do span
> *during* the drag and then collapse to the first block the moment editability
> is restored. Only a permanent single host survives, and that is the trade
> open question 9 weighs.

# Cross-block text selection with per-block contenteditable

Research + measurements, August 2026. This note exists because it is the one
place where our per-block architecture (D1) costs something, and the answer
turned out to be non-obvious.

## TL;DR

- An **editable ancestor is what unlocks cross-host selection**. Measured in
  Chrome 150: two sibling `contenteditable="plaintext-only"` blocks inside a
  plain `<div>` → a click-then-shift-click selection is **clamped** to the
  first host. Put `contenteditable="true"` on the container → it **spans**.
  A `contenteditable="false"` island in between severs the chain again.
- **But a programmatic `setBaseAndExtent` spans leaves without any container
  editable** — measured in our own editor, highlight painted across three
  blocks. The browser refuses to *create* such a range from a gesture, not to
  *hold* one. That asymmetry is what our implementation exploits.
- **Notion** keeps one permanently editable page root
  (`data-content-editable-root="true"`) wrapping per-block
  `data-content-editable-leaf` divs and `data-content-editable-void` islands.
  Writability is gated by a CSS variable on `-webkit-user-modify` rather than
  by toggling the attribute. Its selection is native `::selection`; only the
  voids get a faked highlight. The in-memory selection state is patented
  (US 11,687,701 B1) — the claims are about the *model*, including
  re-parenting orphaned children on cross-block delete, not about the DOM.
- **Gutenberg** toggles `contentEditable` on the writing-flow wrapper for the
  duration of a gesture (three triggers: `mouseout` while dragging,
  Shift+click, Shift+Arrow at a field edge), blocks every key while it is on,
  and turns it off before dispatching any destructive command. It tried making
  the host permanent in July 2026 (PR #79105) and **reverted it on 5 Aug 2026**
  (PR #81184) over iOS double-tap bugs. Its e2e suite is the best public
  catalogue of edge cases for this feature.
- **BlockSuite/AFFiNE** does the same nested-host thing and maps ranges to
  `{from:{blockId,index,length}, to: same-block ? null : {...}}` — the same
  shape as Notion's patent and as our `resolveTextRange`.
- **CSS Custom Highlight API** is interoperable now (Firefox 140, June 2025)
  but is the wrong tool: it paints pixels without producing a *selection*, so
  clipboard, `getTargetRanges()`, caret, IME and assistive tech all still read
  a clamped `document.getSelection()`. No major editor uses it for selection;
  ProseMirror discussed and declined it.

## What we implemented, and why it differs

We drive the gesture ourselves (`dom/src/cross-block-selection.ts`): pointer
drag and Shift+click compute caret positions and call `setBaseAndExtent`
across leaves. No container ever becomes editable.

Chosen over Gutenberg's toggle because it needs no "block every key while the
host is on" machinery, no focus restoration dance, and no attribute mutation
mid-gesture — which is exactly what broke Gutenberg on iOS, twice.

**Known risk, honestly stated:** Gutenberg's own PR #79105 rejected synthetic
pointer handling because "pointer events cannot be reliably intercepted" on
iOS touch. Our approach is therefore expected to degrade on iOS Safari touch
selection, where the fallback is the pre-existing block selection. This is
listed in `docs/TESTING.md` as a device-matrix item; if it fails there, the
remedy is Gutenberg's gesture-scoped container toggle applied *only* on touch.

## Edge cases this feature drags in

Ordered by how soon they bite (from Gutenberg's e2e suite and BlockSuite's
`RangeBinding`), with our status:

| Case | Status |
|---|---|
| Typing over a cross-block range replaces it | done (`deleteTextSelection` then insert) |
| Backspace/Delete over the range, children re-parented | done, one undo step |
| Copy/cut of a partial cross-block range | done; clipboard re-reads DOM truth first, because `selectionchange` is async |
| Formatting the whole range, active state only when fully covered | done (`toggleMarkRange`, `rangeHasMark`) |
| Non-text chrome highlighting when a range crosses it | done (`::selection { transparent }` on voids, as Notion does) |
| Firefox multi-range selections (bug 753718, still open) | guarded: only anchor/focus are read |
| Triple click extending into the next block at offset 0 | guarded (`detail >= 3`) |
| `syncDomSelection` focusing a leaf and re-clamping the range | fixed: focus only when the range is single-block |
| IME composition with a live cross-block range | untested — needs the device matrix |
| iOS touch selection | expected to fall back to block selection; see above |
| Safari paints partial selections with a different model | needs visual check, not assertions |

## Sources

Gutenberg `writing-flow` (`utils.js`, `use-drag-selection.js`,
`use-selection-observer.js`, `use-arrow-nav.js`, `use-input.js`), PRs #272,
#38892, #79105, #80820, #81184, #81042 and
`test/e2e/specs/editor/various/multi-block-selection.spec.js`; Notion patent
US 11,687,701 B1 and shipped bundle CSS; BlockSuite `range-manager.ts` /
`range-binding.ts`; Editor.js `crossBlockSelection.ts`; W3C Selection API,
CSS Custom Highlight API drafts and MDN Baseline data; w3c/editing #470
(nesting `plaintext-only` inside `true` is unspecified).
