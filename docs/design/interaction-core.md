# The interaction core

2026-08-07. The cornerstone: text selection, caret, keyboard navigation,
rubber band, block reordering, and every overlay's dismissal — as one designed
system rather than six that negotiate by accident.

---

## 1. What is actually wrong today

Not opinion. Measured at commit `3630c7d`:

**Five independent pointer listeners on the same surface**, each deciding on
its own whether a press belongs to it, by sniffing the target:

| module | listener | claims the press when |
|---|---|---|
| `caret.ts` | `mousedown` on content | target is a block but not a leaf |
| `cross-block-selection.ts` | `pointerdown` on content | target is inside a leaf |
| `rubberband.ts` | `pointerdown` on content | target *is* the content, or an empty leaf |
| `ui/drag.ts` (×2 sessions) | `pointerdown` on handle / content | `canStart()` says so |
| `ui/position.ts` | `pointerdown` capture on document | always, to dismiss overlays |

Nothing arbitrates. Precedence is whatever order `view.ts` happened to call
`attach*` in, and two of them can start on the same press.

**Three wall-clock back-channels** exist only because those modules have no
shared notion of "what gesture is running":

```
textIntentActive()   500 ms   caret.ts  → selection.ts
justRubberBanded()   300 ms   rubberband.ts → input.ts
dismissedBy()        400 ms   position.ts → every trigger button
```

plus `view.blockGesture` and a `requestAnimationFrame` deferral in
`rubberband.ts` whose comment admits what it is: *"release the gesture only
after the resulting selectionchange has been swallowed"*. Every one of these
was a real bug fix. Every one is timing-fragile: a slow frame under load moves
the boundary, and the bug returns as a flake nobody can reproduce.

**Escape is handled in eight places** — `keymap.ts` (twice), `rubberband.ts`,
`ui/drag.ts`, `ui/menu.ts`, `ui/position.ts`, `link-hover.ts`, `database.ts` —
with no precedence. Two of them listen in the capture phase, so they beat the
others for reasons unrelated to what the user meant. Pressing Escape with a
menu open *inside* a popover closes both.

**The topology is hardcoded at the lowest level.** `leafOf()` closes over
`.nbe-leaf`, and every selection primitive is built on it. The per-block
`contenteditable` decision (D1) is therefore not a decision any more — it is
an assumption baked into the foundation, and testing the single-host
alternative would mean rewriting the foundation.

**Zero tests.** `packages/dom/test/` covers paste, positioning, database and
tables. The cornerstone has none.

## 2. Three primitives, and nothing else

### 2.1 `EditableTopology` — where the editable boundary is

The interaction layer must never know whether the document is one
`contenteditable` or one per block. It asks a topology:

```ts
interface EditableTopology {
  /** The editable host containing a node, or null if outside one. */
  hostOf(node: Node | null): HTMLElement | null;
  /** DOM position → model point. */
  toModelPoint(node: Node, offset: number): Point | null;
  /** Model point → DOM position. */
  toDomPoint(view: EditorView, point: Point): { node: Node; offset: number } | null;
  /**
   * Whether the browser will natively drag-select from `a` to `b`.
   * Per-block: only within one host. Single-host: always.
   * This is the ONE question that separates the two topologies, and answering
   * it false is what makes the cross-block driver necessary.
   */
  nativeRangeSpans(a: HTMLElement, b: HTMLElement): boolean;
}
```

Two implementations ship: `perBlockTopology` (today's `.nbe-leaf` hosts) and
`singleHostTopology` (the content root is the only host). Everything else —
caret reading, arrow navigation, cross-block dragging, goal-X — is written
against the interface and works under both.

The payoff is not hypothetical: D1 was adopted without the A/B spike the
roadmap called for, and this is what makes that spike cheap to run later
instead of impossible.

### 2.2 `GestureRouter` — one press, one owner

A single `pointerdown` listener on the content classifies the press once and
hands it to exactly one recognizer:

```ts
interface GestureRecognizer {
  name: string;
  /** Lower runs first. Explicit, not attach order. */
  priority: number;
  /** May this press start this gesture? */
  match(ctx: PressContext): boolean;
  /** Take the press. Return a session, or null to decline and let the next try. */
  start(ctx: PressContext): GestureSession | null;
}
```

`PressContext` carries what every recognizer was sniffing for anyway — the
event, the resolved block id, the editable host under the pointer (via the
topology), and whether the press landed on interactive chrome — computed
**once**, not five times.

The router owns `view.activeGesture`. That single field replaces
`blockGesture`, `justRubberBanded()` and `textIntentActive()`: `selectionchange`
asks *"is a block-mode gesture running?"* instead of asking *"was a press
inside text within the last 500 ms?"*. State, not timing.

Recognizers ship in this order, which is the whole arbitration story:

1. `overlayDismiss` (priority 0) — never blocks, only records
2. `chrome` (10) — checkbox, toggle arrow, callout icon, links: not ours
3. `blockDrag` (20) — a void block, or a block already selected
4. `textSelect` (30) — the press landed in an editable host
5. `blockClickRoute` (40) — a block, but not its text: route the caret in
6. `rubberBand` (50) — empty editor space

### 2.3 `OverlayStack` — dismissal as a stack, not a broadcast

Overlays push onto a stack when opened and pop when closed. Then:

- **Escape closes the top overlay only**, and stops there. A menu inside a
  popover closes the menu.
- **Outside-press is computed once** against the whole stack, so an overlay
  nested in another does not dismiss its parent.
- **`dismissedBy()` stays**, but keyed on stack identity rather than a 400 ms
  window — the trigger-toggle problem is a state question too.
- One capture listener for the whole stack instead of one per overlay.

Escape precedence overall becomes an explicit chain, evaluated in order:

```
top overlay → active gesture → block selection → text selection → nothing
```

## 3. What this deliberately does not add

- No event bus, no priority negotiation between recognizers at runtime: the
  list is ordered at registration and first match wins. If two things want the
  same press, that is a design decision to make, not a runtime one.
- No abstraction over the browser selection itself. The DOM selection stays
  the authority for reading the caret (that decision was right and is not in
  question); the topology only says how to *interpret* it.
- No re-implementation of `ui/drag.ts`'s session robustness. Its teardown
  rules — window listeners, best-effort capture, Escape/blur/pointercancel,
  exception-safe callbacks — were learned from a real page-freezing bug and
  are reused as the gesture session implementation.

## 4. Order of work

1. `ui/overlay.ts` — the stack. Self-contained, testable, fixes Escape.
2. `topology.ts` — the abstraction, with both implementations.
3. `gestures.ts` — the router; delete the three timing hacks as recognizers
   land.
4. Escape chain wired through the router and the stack.
5. Tests: the cornerstone gets the coverage it never had — arbitration order,
   dismissal precedence, and both topologies against the same selection suite.
