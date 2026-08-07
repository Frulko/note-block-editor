# The landscape Carnet is entering

Surveyed 2026-08-07. Licences read from `LICENSE` files, editor stacks from
`package.json` and shipped bundles, sentiment from Hacker News, Discourse
forums and GitHub issues ranked by reactions. Reddit was unreachable, so
self-hosting sentiment is thinner than the rest.

## The gap, stated precisely

**No editor has Notion-grade WYSIWYG editing whose storage is plain Markdown
files.** Every product picks a side, and the two sides fail differently:

| | Notion-grade editing | Plain files |
| --- | --- | --- |
| Notion, Craft, Coda, Nuclino, Capacities, Tana | yes | no |
| Anytype, AppFlowy, AFFiNE, SiYuan, Logseq 2.0, Joplin, Trilium | yes-ish | no |
| Obsidian, Logseq 1.x, Reflect (open) | no — CodeMirror text editing | yes |

**The file side fails at editing.** Obsidian's Live Preview is a text editor
pretending to be a document editor, and its own forum documents the seams:
tables that stay raw, footnotes that do not render, maths broken inside
callouts, selection breaking at links. Plugin authors cannot fix it — they
report no access to the built-in editor extensions and no way to extend the
Markdown parser. The complaint has a canonical form: *"seeing and editing
format codes all over the place"* is not good WYSIWYG.

**The app side fails at exit, and existentially.** Notion's databases export as
CSV only — Obsidian paid a $5,000 bounty to work around it. Tana's Markdown
export drops supertags and fields. Anytype's loses relations and has no
Markdown *import* at all. The user-facing consequence is stated in identical
words across three separate communities: the decisive reason to leave is that
you cannot leave.

**A third failure became decisive in 2026: agents.** Files are an interface
now, not just an archive. The Logseq 2.0 backlash was not nostalgia — it was
"half the edits are done by Claude" and "not being able to use Claude or codex
to write or update pages is a real deal breaker". Every locked-in product is
currently reimplementing, badly, what `grep` gives a vault for free.

**A fourth, quieter one: mobile.** Notion mobile takes ten seconds to open for
heavy users; Anytype's Android takes 45 seconds at 8,000 objects; Obsidian's
own community rates its mobile 3/5 and calls capture "awkward and kludgy";
AFFiNE has none. **Nobody has shipped a block editor that is good with a
thumb.**

And the market has vacated single-player: Notion pivoted to agents and
enterprise, Coda was absorbed into Superhuman, Tana renamed its outliner and
moved it to a subdomain, Logseq left files. The holdouts are the ones that
refused venture money — Obsidian, Capacities, Reflect.

## The two competitive events that matter

**Obsidian Bases shipped in 2025**, and it attacks the database gap from the
file-over-app side: list/table/card views over note properties, data staying in
Markdown, rated 5/5 by Obsidian's own community. Our "databases as a file
projection" differentiator has a shorter runway than it did a year ago.

What Bases cannot do, because CodeMirror 6 will not let it, is **Notion-grade
block editing**. That is the durable half of the wedge, and it is the half we
are built on.

**Reflect open-sourced a full rewrite under MIT in June 2026** — Tauri 2, Rust,
Markdown files as the source of truth, iCloud or git sync, an agent CLI, no
account. It is the closest thing to a direct competitor to our positioning, it
is two months old, and it has neither databases nor a block editor.

## What the evidence says about our own decisions

**It corroborates the D1 warning** recorded separately in
`per-block-contenteditable-evidence.md`: per-block `contenteditable` is listed
here among the known-bad architecture choices, because it is what Notion left
in January 2021. Same finding, second source.

**It validates Loro**: MIT, Peritext rich text over Fugue (which handles the
interleaving that bites naive algorithms), a movable-tree CRDT for block
reordering, and shallow snapshots that truncate history — typically 70–90%
smaller. That last one matters against a cost AFFiNE quantifies from its own
production: 10k modifications peaking at 1 GB of memory, 100 MB of Postgres per
1,000 documents.

**It validates "CRDT-shaped, CRDT-free" as the v1 posture.** Tana's public
post-mortem for a full rebuild is one sentence: *collaboration is not a layer
you can bolt on at the end.* Notion retrofitted CRDTs in 2025 after a decade of
last-writer-wins and still loses one of two concurrent property updates. Stable
block ids, op-shaped mutations and identity-based anchors are the part that
cannot be retrofitted cheaply, and they were in place from the start.

**It says the sync story should converge to a clean file.** A CRDT that
*replaces* the file is the position everyone else took. A CRDT that converges
to readable Markdown is unclaimed.

## Table stakes, from the survey

Missing two of these reads as "not a block editor" immediately. Recorded here
so they can be checked against what we ship rather than assumed:

- **Slash menu** opens only on a literally typed `/` — never on paste, undo, or
  programmatic insertion; filters as you type; deletes the query text before
  the block lands; Escape closes without eating the text; opening it dismisses
  every other overlay.
- **Gutter** fades in a grip and a `+`; the grip both opens the menu and drags.
  The drop indicator distinguishes sibling (solid) from child (dashed,
  indented) past a nesting threshold. Drops in the gap land on the nearest
  block rather than doing nothing. Edge auto-scroll ramps.
- **Keyboard** is where credibility is won: `Esc` selects the block and `Esc`
  again clears; `Cmd+A` escalates text → block → parent → document; `Tab`
  indents structurally; `Cmd+Shift+↑/↓` moves blocks **through the same code
  path as the drag**, or the two disagree at the edges; autoformat is undoable
  back to literal text in one `Cmd+Z`; deleting the last block leaves a fresh
  paragraph rather than an invalid empty document.
- **Performance**: keystroke to paint under 16 ms. Notion's own diagnosis of
  why it loses to Google Docs is that its rendered DOM is also its input
  surface — any architecture where a keystroke triggers a wide re-render
  inherits that. Sub-second cold start and sub-100 ms search at 10k notes is
  the bar that is visibly better than everyone.

## Anti-patterns, which are mostly about restraint

1. **Unsolicited AI** is now the most reliable source of contempt in the
   corpus. If it ships: user-supplied keys, off by default, local-capable,
   per-note opt-out. AppFlowy's self-hosted stack will not boot without an
   OpenAI key; that is their most-upvoted open issue.
2. **Migrating off files for good architectural reasons.** Logseq did it in
   July 2026. No engineering justification survives contact with the response.
3. **Partial or opt-in offline** invites trust it cannot repay. Notion's 2025
   offline mode requires pre-downloading pages and caches the first 50 rows of
   the first view of a database.
4. **Perpetual beta**, and abandoning the shipping version for a rewrite.
5. **Complexity as power.** Obsidian's CEO asked what to *remove* and mostly
   got feature requests. The discipline is the product.
6. **Plugins as a substitute for a good default.** Obsidian's are its most
   praised feature and the source of theme breakage every update, and a real
   remote-access trojan once shipped through one.
7. **Gating basics to fund AI.** AppFlowy's undocumented one-seat self-host cap
   produced, verbatim, "what's the point of me leaving Notion?"
8. **Quiet trust leaks.** Notion's published pages expose contributor names,
   photos and email addresses in metadata. One incident permanently changes how
   a product is discussed.

## Notes on individual products

Kept short; the point of this file is the synthesis above.

- **Obsidian** — closed source, seven people, no investors, and that fact is
  load-bearing for its trust. Handles 53,000 files on desktop. Its weaknesses
  are the editor, mobile, DIY-sync data loss, and the absence of any
  permissions model.
- **Anytype** — *not* open source: the Any Source Available License permits
  non-commercial use only, and the request for an OSI licence was closed
  `wontfix`. Its change-DAG CRDT deliberately rejects text CRDTs, so there is
  no character-level merge, and the forum carries a recurring, unfixed
  scrambling bug on large documents.
- **AFFiNE** — the closest technical relative and the best reference
  implementation, but its backend is under an Enterprise Edition licence
  forbidding redistribution, and **BlockSuite is dead**: its former
  second-largest contributor stated publicly in July 2026 that funding fell
  through and the maintainers left; the standalone repo has had no commits in
  a year. Read it; do not depend on it.
- **AppFlowy** — AGPL, but the shipping product is a closed-source fork by
  their own README's admission. Documents live in RocksDB as binary updates.
  Worth stealing one idea: it bypasses Flutter's text widget and attaches to
  the platform IME directly.
- **Outline / Docmost / Trilium** — the conventional, solid self-hosted tier.
  Outline is BSL 1.1 and may not be run as a document service. Trilium's
  advocates give the strongest counter-argument to file-over-app in the whole
  corpus: typed notes and query power, "your notes system is essentially a
  glorified RDBMS".
- **Capacities** — the best architecture nobody credits: SQLite WASM over OPFS,
  and an export that respects structure (Markdown plus YAML front matter plus
  CSV sidecars). Its sync has no documented conflict resolution anywhere.
- **Nuclino** — fewer features than anyone here and wins users purely on
  latency. The existence proof that speed alone is a viable wedge.
