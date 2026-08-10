# Carnet for Obsidian

A block editor for one note at a time. The file stays Markdown.

## What this is, and is not

It is the editor: slash menu, drag handles, block selection, autoformat,
tables, callouts, toggles, columns.

It is **not** a workspace. No real-time, no sync, no sidecar files, no `.nbe/`
directory. Obsidian keeps ownership of loading, saving, renaming and conflict
handling; this plugin supplies an editing surface and stays out of everything
else. That boundary is the design, not a limitation to be lifted later — see
`docs/research/obsidian.md`.

What the note itself can carry, it carries — in its YAML frontmatter, where
every other tool already looks for a document's metadata:

- **The discussion.** Comment threads live in the note's `nbe.comments`
  property, anchored to their block by a `%%^id%%` marker in the line (which
  Obsidian's reading mode renders as nothing). A note carried away on a USB
  stick arrives with its comments.
- **A title the filename cannot hold.** « Réunion : 2026/07 » is a note called
  that, in a file called `Réunion 2026 07.md`, because a vault names notes
  `<Titre>.md` and resolves `[[wikilinks]]` by that name. The `title` property
  is written only when the two differ.

Everything else up there is yours: `tags`, `aliases`, `cssclasses` and any
property a plugin of yours wrote come back out of a save byte for byte.

It does not take over Markdown. Your notes still open in Obsidian's editor;
Carnet is opt-in per note, from the command palette.

## Use

- **Ouvrir cette note dans Carnet** — switch the current note to the block
  editor.
- **Revenir à l'éditeur Markdown** — switch back.

Saving is Obsidian's own debounced writer, so external changes, conflicts and
shutdown behave exactly as they do everywhere else in the app.

## Known limits

- **Block ids are per session.** Markdown has nowhere to keep them and this
  plugin adds no sidecar, so undo lives in the session. Deep links and
  backlinks are workspace features and belong to the app.
- **The Markdown round trip is lossy where Markdown is.** Column layouts
  flatten, and anything with no Markdown equivalent is written as an HTML
  comment marker rather than dropped. This is the documented D7 loss.

## Settings

Everything data-shaped in `EditorViewOptions` is in the plugin's settings tab:
text column width, page margins, spellcheck, experimental drag-to-columns,
read-only mode, per-feature toggles (slash menu, mentions, gutter, toolbars,
link hover, databases) and theme overrides as CSS custom properties. The
function-shaped options (page hosts, asset stores, custom blocks, labels) are
code, not settings. Changes apply immediately to open Carnet views.

## Build

```sh
pnpm --filter @nbe/obsidian build
```

Every build assembles `dist/carnet/` — the ready-to-drop plugin folder
(`main.js`, `manifest.json`, `styles.css`, with the editor's stylesheet
bundled in). Copy it to `<vault>/.obsidian/plugins/carnet/`, or let the build
do it:

```sh
pnpm --filter @nbe/obsidian build --vault ~/Documents/MyVault
```

`--watch` works with both.
