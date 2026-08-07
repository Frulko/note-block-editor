# Decision: Obsidian plugin, or a standalone app?

The roadmap defers this one: *"decide plugin vs standalone app once L1 vaults
are stable — an L1 workspace already **is** an Obsidian vault, which keeps both
doors open."* Vaults shipped in phase 4, so the condition is met. Written
2026-08-07.

**Recommendation: standalone app, with the vault as the interoperability
surface.** That is what is already built, and the reason is not inertia — a
plugin would invert §10's authority flow, which is the project's spine.

## The claim the decision rested on was false, and is now true

The sentence above had never been checked. It was **false** for any page whose
title holds a character a filename cannot.

A vault names a page `<slug>.md`, stripping `/ : ? *` and the wikilink syntax
characters. The link *to* that page was written from the raw title. So a page
called `Réunion : 2026/07` was filed as `Réunion 2026 07.md` and referred to as
`[[Réunion : 2026/07]]` — a dangling link in any vault reader, and mentions had
the same fault from the same cause. Two resolution rules, written in two
places, drifted the moment one of them learned about filesystems.

Fixed in `27206be` by emitting `[[slug|Title]]` when the two differ, at the one
place every wikilink is written. Verified by applying Obsidian's own resolution
rule — same folder first, then anywhere in the vault — to every link an export
produces (`packages/workspace/test/obsidian.test.ts`).

The claim is now true, and it is true *because it is tested*, which is the only
form in which it can be relied on for a decision.

## Why not a plugin

Not effort — the DOM package would mount in Obsidian's Electron renderer
without much trouble. The objection is architectural.

§10 makes **L0 (nested JSON) canonical and L1 (Markdown) a projection**. A
plugin inverts that: Obsidian owns the file, so Markdown becomes canonical and
L0 demotes to a cache of it. Everything the project has decided rests on the
other order:

- **Block ids** (D6) are per *block*; Markdown carries an id per *page*, in
  frontmatter. As a plugin, block anchors, deep links and backlinks either
  vanish or need a marker syntax in the text — visible junk in a file whose
  whole promise is being readable.
- **D7's documented loss** — a sub-page and a link-to-page both project to
  `[[wikilink]]`, and the distinction is recovered from folder layout — is
  acceptable *once*, at an export boundary. As a plugin it would sit on the
  round trip of every keystroke.
- **The op model and undo** are closed and invertible over L0. Over a lossy
  projection they are not invertible at all.

Inverting the authority flow is not a plugin. It is a different product that
shares a rendering layer, and it would cost the guarantees the last four phases
were spent establishing.

## What the vault already buys, at no further cost

The third option is the one that was quietly built: **the user opens the same
folder in both.** This is not aspirational — the pieces exist and are tested.

- The export layout *is* the Obsidian convention: `<Title>.md`, children in a
  `<Title>/` folder, ids in YAML frontmatter.
- Every wikilink resolves under Obsidian's own rules (now tested).
- `.nbe/` holds the canonical JSON and Obsidian skips dot-directories, so the
  two coexist without either seeing the other's bookkeeping.
- Edits made *in Obsidian* flow back: `packages/cli/src/watch.ts` polls content
  hashes and re-imports through the same parser as Notion-import, preserving
  ids via frontmatter — §10's own requirement.
- Rows-as-pages (§2.5) is already the Obsidian convention for a database, which
  is why the collection export produces a Bases-shaped `.base` view file.

So Obsidian is not a port target. It is a *reader and second editor* of a
format we already emit, and the door stays open in the direction that costs
nothing.

## What is genuinely unresolved

Concurrency, and it is the honest gap. The watcher imports external edits, but
nothing arbitrates a page edited in both programs *at the same time*: last
writer wins at page granularity. That is fine for one person moving between two
apps and wrong for two apps writing the same page in the same second.

The fix is not Obsidian-specific and is already scoped elsewhere — phase 5's
CRDT makes concurrent edits merge rather than clobber. Until then the safe
statement is "edit in one at a time", and that should be said plainly to the
user rather than discovered.

Also untested: whether Obsidian's own editor, saving a file we wrote, reflows
anything we then read back differently. The watcher deliberately does not write
the vault back during an import, which limits the blast radius, but a real
round trip through Obsidian's save has not been run. It needs the application,
not a test.

## Revisit if

Someone wants our *editing experience* inside Obsidian specifically — that is
the one requirement this recommendation does not serve, and it would be a
custom view type over files Obsidian's own editor could no longer open.

---

## Revision, 2026-08-07 — the recommendation above was too narrow

Written the same day, after the competitive survey
(`competitive-landscape.md`) and after the project owner reframed the plugin's
scope. Both changed the answer, and the earlier reasoning was not wrong so much
as aimed at a question nobody asked.

**What I got wrong.** The objection above is entirely about *authority*: a
plugin would make Markdown canonical and demote L0 to a cache of it. That
objection holds only for a plugin that owns a **workspace** — sub-pages,
backlinks, databases, undo across pages. The owner's actual brief is narrower
and it dissolves the problem:

> just the editor. No comments, no real-time, no sync.

An editor-only plugin edits **one file at a time, in place**. It does not need
a canonical L0 for a workspace, because it is not managing a workspace. §10's
authority flow is untouched, because nothing is claiming authority over
anything but the buffer currently open. What I argued against was a product
nobody proposed.

**And the survey says this is the sharpest move available, not a concession.**
The gap it found is that *no editor has Notion-grade WYSIWYG editing over plain
Markdown files*. Obsidian is on the wrong side of it and structurally cannot
cross: Live Preview is CodeMirror 6, its own forum documents the seams — raw
tables, unrendered footnotes, maths broken in callouts, selection breaking at
links — and plugin authors report they have neither access to the built-in
editor extensions nor a way to extend the parser.

Meanwhile Obsidian Bases (2025) is attacking the *database* gap from the
file-over-app side, free, and rated 5/5 by its own community. So the half of
our wedge that Obsidian is closing is databases, and the half it cannot close
is the editor.

Putting our editor inside Obsidian is therefore aimed at exactly the thing
Obsidian cannot fix and we already have. It reaches an audience that has
already chosen file-over-app, needs no sync story, no account, and no server —
and it is the cheapest possible distribution of the one asset the survey says
is genuinely scarce.

**Revised recommendation.** Both, and they are not in tension:

1. **The standalone app** stays the product, for the reasons above — L0
   canonical, workspace, databases, sync.
2. **The Obsidian plugin ships the editor alone**, mounted as a view over a
   vault file. No comments, no presence, no CRDT, no `.nbe/`. When it saves, it
   writes Markdown, because in that context Markdown *is* the document.

The constraint to hold: the plugin must not grow a workspace. The moment it
wants sub-pages, backlinks or undo across files, the original objection comes
back in full, and the answer is to point that user at the app.
