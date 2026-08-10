import type { APIRoute } from 'astro';

/*
 * `/llms.txt` — the site, written for something that reads rather than browses.
 *
 * The convention (llmstxt.org) is an index with context, not a dump: a model
 * arriving with a question needs the *shape* of the thing and where to go for
 * the rest, and a generated API dump gives it the rest without the shape. The
 * reference already exists — typedoc builds it from the source and cannot
 * drift — so this file is the half typedoc cannot write: what the pieces are
 * for, which invariants are load-bearing, and the traps that make otherwise
 * reasonable code wrong here.
 *
 * Short on purpose. Everything below is checked against the source at the time
 * of writing, and a page that is too long to re-read is a page that goes stale
 * silently.
 */

const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const site = 'https://frulko.github.io';
const url = (path: string) => `${site}${base}${path}`;

const body = `# Carnet / notion-block-editor

> A block editor with Notion's editing feel, in vanilla TypeScript, whose
> storage is a folder of Markdown files. The document is data — an intermediate
> schema — and the DOM is a disposable projection of it, never the source of
> truth. Headless core, one DOM view, thin framework mounts.

The packages are ESM, side-effect free, and consumed by import: what you do not
import is not in your bundle. \`@nbe/core\` has zero dependencies and touches no
DOM, which is what lets the same document run in a browser, in Node, in a CLI,
in an Obsidian plugin and in a Swift port.

## Orientation

- [Why this editor](${url('/docs/why/')}): the four decisions it is built on.
- [Everything it does](${url('/docs/features/')}): the feature catalogue, by category.
- [Getting started](${url('/docs/getting-started/')}): install, mount, save.
- [Where it runs](${url('/docs/hosts/')}): library, desktop app, Obsidian plugin, iOS, headless relay.
- [Markdown](${url('/docs/markdown/')}): the file format and what round-trips.

## Concepts

- [Blocks and schema](${url('/docs/concepts/blocks/')}): what a block is, what a schema declares.
- [Operations](${url('/docs/concepts/operations/')}): the seven, and why undo/sync derive from them.
- [Projections](${url('/docs/concepts/projections/')}): DOM, Markdown and HTML as outputs of one model.

## Reference

- [API overview](${url('/docs/api/')})
- [Editor: methods and events](${url('/docs/api/editor/')})
- [Configuration](${url('/docs/api/configuration/')}): every \`EditorViewOptions\` field.
- [Theme and CSS](${url('/docs/api/theming/')}): the token layer.
- [Plugin API](${url('/docs/api/plugins/')})
- [Writing a block](${url('/docs/extending/plugins/')})

## The parts

| Package | What it is |
| --- | --- |
| \`@nbe/core\` | The document, schema, selection, transactions, history, commands. No DOM, no dependencies. |
| \`@nbe/dom\` | The browser projection: rendering, input, menus, drag and drop. Depends on core and markdown. |
| \`@nbe/markdown\` | Markdown in and out, including the YAML header. |
| \`@nbe/static-renderer\` | HTML without a browser or an editor instance. |
| \`@nbe/collab\` | Loro CRDT sync, cursors, history. |
| \`@nbe/workspace\` | A vault on disk: pages, backlinks, search index. |
| \`@nbe/react\`, \`@nbe/vue\`, \`@nbe/svelte\` | Thin mounts. Exactly two dependencies each, CI-enforced. |
| \`@nbe/blocks-*\` | One block type per package: code, table, callout, toc, mermaid, embed, dropzone, mdx. |

## Mounting one

\`\`\`ts
import { Editor, createDoc, docToJSON } from '@nbe/core';
import { EditorView } from '@nbe/dom';
import '@nbe/dom/style.css';

const editor = new Editor({ doc: createDoc() });
const view = new EditorView(element, editor);
editor.on(() => save(docToJSON(editor.doc)));
\`\`\`

\`EditorView\` takes a third argument, \`EditorViewOptions\`. The host-shaped ones
are functions the editor calls and never implements: \`onStoreAsset\`,
\`resolveAssetUrl\`, \`onSearchPages\`, \`onCreatePage\`, \`onOpenPage\`, \`onComment\`,
\`onResolveLink\`. A capability with no host hook is **not rendered at all**
rather than rendered dead — the "Page" slash entry is absent without
\`onCreatePage\`, the comment button without \`onComment\`.

## The seven operations

Every change to the document is one or more of these, and nothing else:

\`\`\`
insert_block  delete_block  move_block  update_block
insert_text   delete_text   format_text
\`\`\`

They are applied in a transaction, and each returns its inverse — which is
where undo, persistence and CRDT sync all come from:

\`\`\`ts
editor.dispatch(
  (tx) => tx.op({ type: 'update_block', id, patch: { props: { checked: true } } }),
  { origin: 'ui' },
);
\`\`\`

\`origin\` is one of \`input\` | \`ui\` | \`api\` | \`keyboard\` | \`dom\` | \`remote\`, and it
matters: \`dom\` means "do not move focus or scroll", which is what a live
selection paint needs.

## Writing a block

A block is a package with two halves. The model half declares the schema and
the Markdown projection and must load without a DOM — a CLI, a server and the
Swift port all consume it. The \`/dom\` half declares the view. \`@nbe/dom\` is a
**peer** dependency, never a dependency; CI fails the build otherwise.

\`\`\`ts
import { PLUGIN_API_VERSION, type BlockPlugin } from '@nbe/core';

export const callout: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: { type: 'callout', version: 1, inline: true, spelledProps: ['icon'] },
  markdown: {
    toMarkdown: (block, ctx) => [\`> \${ctx.inline(block.text)}\`],
    fromMarkdown: [{ match: /^> /, parse: (lines, at) => ({ block: …, consumed: 1 }) }],
  },
  view: { render(ctx, block) { … }, slash: [{ label: 'Callout', keywords: ['callout'], icon: 'quote' }] },
};
\`\`\`

Things that are load-bearing and easy to get wrong:

- **\`spelledProps\` decides what the file says out loud.** A prop listed there is
  written in the Markdown syntax itself; everything else rides in an HTML
  comment marker beside the line, which every other tool ignores. Declaring
  none means the block writes no marker at all.
- **A round-trip must be byte for byte.** Opening a note and closing it leaves
  no diff. That is the promise the whole format rests on, and \`toMarkdown\` /
  \`fromMarkdown\` are tested as a pair against it.
- **\`literal: true\`** for a block whose text is characters rather than markup —
  a code block. It stops \`toggleMarkRange\` writing a mark the Markdown
  projection would then have to throw away, and drops the floating format bar.
- **A void block has no caret.** Pressing it selects it; Enter opens a
  paragraph under it.

## Extending the chrome

- \`EditorFeature\` is \`{ name, attach(view): () => void }\`. \`defaultFeatures\` is a
  plain array — copy it, remove what you do not want, and what you removed is
  not in your bundle. \`minimalFeatures\` is the smallest thing that still edits;
  \`readOnlyFeatures\` is empty.
- \`view.slot('top' | 'bottom' | 'floating')\` is a container that is a *sibling*
  of the content element, so a re-render cannot wipe it. The word counter, the
  floating outline and the pinned format bar all live there.
- \`view.recognizers\` is the pointer-gesture list, in precedence order. One
  press has exactly one owner.
- Appearance is host-facing attributes, not options: \`data-nbe-theme\`,
  \`data-nbe-code-theme\`, \`data-nbe-typeface\`. They reach the chrome portaled
  out of the editor as well as the page, which an option threaded through
  three packages would not.
- Labels: \`EditorLabels\` is a complete dictionary, never a patch. English is
  the default and the only pack a bundle carries unless another is named.

## What this editor will not do

Stated because a model asked to "add a feature" should know which ones were
declined on purpose:

- No dependency for something a few lines can do. \`@nbe/core\` has zero.
- No abstraction with one implementation, and no config for a value that never
  changes.
- Nothing that makes the file on disk unreadable by other tools.
- No network from \`@nbe/dom\`. Fetching belongs to the host, which is why
  \`onResolveLink\` exists rather than a fetch inside the link card.

## Source

- Repository: https://github.com/Frulko/carnet
- Architecture notes: \`docs/ARCHITECTURE.md\`; testing matrix: \`docs/TESTING.md\`
`;

export const GET: APIRoute = () =>
  new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
