# The licence decision, reduced to one word

This is the last thing blocking publication, and it is the project owner's call.
What follows is the evidence, so the call is a choice between two named options
rather than an open question. Written 2026-08-08, from
`docs/research/competitive-landscape.md`.

## What the survey found about licences, specifically

Licence choice turned out to be one of the strongest trust signals in this
market, and the failures are consistent.

**"Source-available" is read as a bait and switch.** Outline is BSL 1.1 and may
not be run as a document service. AFFiNE's README says the backend is *"free
for self-host under the MIT license"* while its pricing page says you *"may
review the backend source code only"* — a contradiction users have been asking
about in an open issue for months with no maintainer reply. The recurring
phrasing across Hacker News is the same: *"not actually open source."* Anytype
ships under a bespoke non-commercial licence and closed the request for an OSI
one as `wontfix`.

**AGPL is the norm for a self-hostable notes app** and carries no such stigma:
Logseq, SiYuan, Joplin, AppFlowy, Docmost and Trilium are all AGPL, and none of
their complaint threads are about it.

**MIT is the norm for anything a developer imports.** Reflect's 2026 rewrite is
MIT; AFFiNE's non-server code is MIT.

**A split licence is its own failure mode.** AFFiNE's is the cautionary tale:
the boundary moved once in a commit labelled "docs: update docs", quietly
widening the proprietary side, and the README was never reconciled. The lesson
is not "never split" — it is that a split you cannot state in one sentence will
be misread, and the misreading will be the generous-to-you one until someone
notices.

## What makes this project awkward

It is two things at once:

- **Packages** — `@nbe/core`, `@nbe/dom`, `@nbe/markdown` and the framework
  bindings. These are meant to be imported. An AGPL editor library is unusable
  by most of the people who would otherwise adopt it, and adoption is the whole
  point of shipping bindings for three frameworks.
- **Applications** — Carnet desktop, the Obsidian plugin, `nbe serve`. These
  are meant to be run. AGPL here is what stops someone reselling the node as a
  service without contributing back.

## The two defensible answers

**Option A — MIT everywhere.** One sentence, no boundary to misread, maximum
adoption, and it matches what the ecosystem expects of an editor library. The
cost is real and should be said out loud: someone can take this, host it, and
give nothing back. Reflect chose this in June 2026.

**Option B — MIT for the packages, AGPL-3.0 for the applications.** Keeps the
library adoptable and stops the node being resold closed. The cost is the
boundary, and the survey says boundaries get misread — so it only works if the
README states it in one line and the per-package `license` fields agree with
that line exactly.

**Recommendation: Option A, MIT.** Not because the protection in B is worthless,
but because this project's scarce asset is the *editor*, the survey says the
gap it fills has a limited runway (Obsidian Bases is closing the other half),
and every hour spent explaining a licence boundary is an hour not spent on the
input surface that still needs a device. B is the right answer later, if and
when there is a hosted product to protect — and moving MIT → dual is a decision
you can still make, whereas the reverse is not.

Apache-2.0 is a reasonable substitute for MIT if an explicit patent grant
matters; it is longer and slightly less expected in this corner of the
ecosystem, and nothing in the survey suggests anyone chooses a note editor on
that basis.

## What happens once the word is chosen

Eleven packages are missing `license`, `repository`, `author` and `description`,
and there is no `LICENSE` file at the root. `scripts/set-licence.mjs` writes all
of it from two arguments, so the decision is genuinely one command:

```sh
node scripts/set-licence.mjs MIT https://github.com/<you>/<repo>
```

It refuses to invent either value, which is the point.
