# External evidence on D1 (per-block `contenteditable`)

Found 2026-08-07 while surveying competitors. This is the first *outside*
evidence about the decision the whole editor rests on, and it is not
reassuring. Recording it plainly.

## What D1 says

Every block is its own `contenteditable="plaintext-only"` host. The roadmap
notes Phase 0's A/B spike was folded away because the hypothesis "was
implemented directly", and that the alternative — one big editing host — was
never actually built and measured.

## The evidence

**Notion tried this exact architecture and abandoned it.** From a Notion
engineer (`jitl`) on Hacker News, 28 June 2023, commenting on AFFiNE:

> Notion used this strategy until January 2021, when we rolled over to
> one-big-ContentEditable. I actually tried the tactic Affine is using —
> implementing drag-to-select gesture yourself and forcing that selection on
> the browser — but I hit a bunch of roadblocks on iOS and Android that made me
> abandon it.

Two things make that quote load-bearing rather than anecdotal:

1. It describes **precisely** what we do, including the part we discovered
   independently: D3 was falsified here — `Selection` is clamped to its
   starting host — so the model carries cross-block selection and the CSS
   Custom Highlight API paints it. That *is* "implementing drag-to-select
   yourself and forcing that selection on the browser".
2. The failure he names is the one we have not tested. Our roadmap already
   says the real-device IME matrix is the open gap (AQ#6): Android GBoard,
   which actively lies about `beforeinput`, and iOS Safari.

**And the project that kept the architecture has exactly those bugs, open.**
AFFiNE's tracker, from the same survey: Android text deletion duplicating
content (open since August 2025, still open a year later), unable to type
normal text in the Android app, the Samsung keyboard broken, Chinese IME broken
on Android. Their Play Store rating is 2.8. Those are not incidental bugs; they
are the class of bug the quote predicts, in the product that made the same
choice.

## What this does and does not mean

It does **not** falsify D1. The evidence is second-hand, five years old in
Notion's case, and browsers have moved — `plaintext-only` and the Custom
Highlight API are both newer than January 2021, and both are load-bearing here
in ways they could not have been for Notion then.

It does mean the burden of proof has flipped. Until now, per-block was the
default and single-host was the thing that would need justifying. After this,
**per-block is the thing that needs evidence**, and the evidence has to come
from real Android and iOS devices, because that is exactly where both data
points say it fails.

## How affordable it actually is — measured 2026-08-08

The roadmap said "D1's unspiked alternative is now a config change", and I
repeated that to the project owner before checking it. **It is not true today.**

Running the whole browser suite with `TOPOLOGY=single-host` — which the
fixtures already supported, and which nobody had run — gave **99 passed, 12
failed**. The claim rested on the *unit* topology suite, which does run against
both; the end-to-end suite never had.

One root cause accounted for a quarter of it, and is fixed: `attachInput`
guarded on `leafOf(event.target)`, which is only right when each leaf *is* the
editing host. Under single-host the host is the root, the browser reports the
root as the target, and the guard rejected every keystroke — autoformat never
fired, Backspace deleted nothing. The leaf is now resolved from the selection
when the target does not give one. **12 failures → 9**, with the default
topology unchanged at 116/116.

The nine that remain cluster in paste handling and cross-block selection, and
they are real work, not configuration. So the honest statement is: the escape
hatch exists and is *most* of the way there, and switching to it today would
cost a focused piece of work rather than a flag. That is still far cheaper than
an architecture change — and it is no longer a claim, it is a number that CI
can keep honest.

So the action is not a rewrite. It is:

1. ~~Run the existing suites under `singleHostTopology`~~ — done, and it is
   what produced the numbers above. `TOPOLOGY=single-host npx playwright test`
   is the command; keeping it in CI is what stops the alternative bit-rotting
   back into a claim.
2. Close the remaining nine. Paste handling and cross-block selection, and both
   are tractable — the first one fixed took an afternoon's reading and one
   guard.
3. Get the touch/IME matrix onto real Android and iOS hardware. This was
   already the open question; it is now the *decisive* one, and it is blocked
   on devices rather than on work.
4. If per-block fails on real hardware in the way both data points predict,
   switch the default — by then a flag rather than a project.

## Related

- AQ#6 (real-device IME matrix) — now the decisive open question, not a
  residual one.
- AQ#9 (whether the accessibility gap forces single-host) — the same switch
  answers both if it comes to that.
- `docs/design/interaction-core.md` — where the two topologies live.

One more note from the same survey, unrelated to D1 but worth knowing before
anyone reaches for it: **BlockSuite, AFFiNE's editor framework, is not a viable
dependency.** Its former second-largest contributor stated publicly in July
2026 that the project is dead and the maintainers have left; the standalone
repository has had no commits in a year. Its architecture is still worth
reading. It is not worth depending on.
