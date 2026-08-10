import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../packages/markdown/src/index';
import { plainText } from '../packages/core/src/index';
import type { BlockJSON } from '../packages/core/src/index';

/**
 * Our own documentation, run through the parser.
 *
 * @remarks
 * D7 promises markdown is two-way with a documented loss boundary. The unit
 * tests pin each rule in isolation; this checks the rules compose on a real
 * hand-wrapped document — which is where the list-item wrapping bug was
 * actually found (docs/ARCHITECTURE.md §12, reported 2026-08-07: every item
 * renumbered to 1 because its continuation lines became paragraphs between
 * the items).
 *
 * The property is **idempotence**, not equality with the source: normalising
 * source wrapping away is the deliberate loss, so `parse → print` is allowed
 * to differ from the input once, and never again after that.
 */

const DOCS = join(import.meta.dirname, '..', 'docs');
const files = readdirSync(DOCS).filter((f) => f.endsWith('.md'));

const shape = (blocks: BlockJSON[]): unknown =>
  blocks.map((b) => ({ type: b.type, text: plainText(b.text), children: shape(b.children ?? []) }));

describe('our own docs survive the markdown round trip', () => {
  it('finds documents to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} is stable after the first normalisation`, () => {
      const source = readFileSync(join(DOCS, file), 'utf8');
      const once = blocksToMarkdown(markdownToBlocks(source));
      const twice = blocksToMarkdown(markdownToBlocks(once));
      expect(twice).toBe(once);
      // and the structure, not just the bytes
      expect(shape(markdownToBlocks(twice))).toEqual(shape(markdownToBlocks(once)));
    });
  }

  it('ARCHITECTURE §12 is nine consecutive numbered items', () => {
    const blocks = markdownToBlocks(readFileSync(join(DOCS, 'ARCHITECTURE.md'), 'utf8'));
    const start = blocks.findIndex((b) => plainText(b.text).startsWith('Storage runtime/platform.'));
    expect(start).toBeGreaterThan(-1);
    // nothing may sit between them: a stray paragraph is what restarted the
    // numbering, since the DOM counts consecutive siblings
    const after = blocks.slice(start);
    const run = after.findIndex((b) => b.type !== 'numbered_list_item');
    expect(run === -1 ? after.length : run).toBe(9);
  });
});

/**
 * `/llms.txt`, and the links in it that can rot.
 *
 * @remarks
 * The file is an index with context (llmstxt.org) rather than a generated API
 * dump — typedoc already writes the reference from the source and cannot
 * drift, so this one carries the half typedoc cannot: what the pieces are for,
 * and which invariants are load-bearing. That half is hand-written, which
 * makes its links the part that goes stale.
 *
 * A dead link in a page a *person* reads is an annoyance; in a file whose whole
 * purpose is to send a reader somewhere, it is the file failing at its one job.
 * So every route it names has to exist as a page.
 */
describe('the llms.txt index points at pages that exist', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'site', 'src', 'pages', 'llms.txt.ts'), 'utf8');
  const PAGES = join(import.meta.dirname, '..', 'site', 'src', 'pages');

  /** Every `url('/…')` the file builds a link from. */
  const routes = [...source.matchAll(/\burl\('([^']+)'\)/g)].map((m) => m[1]!);

  const exists = (route: string): boolean => {
    const clean = route.replace(/^\/|\/$/g, '');
    const stem = join(PAGES, clean);
    for (const candidate of [`${stem}.astro`, `${stem}.md`, `${stem}.mdx`, join(stem, 'index.astro')]) {
      try {
        readFileSync(candidate);
        return true;
      } catch {
        /* try the next shape */
      }
    }
    return false;
  };

  it('names some, or the regex has stopped matching', () => {
    expect(routes.length).toBeGreaterThan(8);
  });

  it('every one of them is a page in the site', () => {
    expect(routes.filter((r) => !exists(r))).toEqual([]);
  });

  it('stays short enough to be re-read — a stale index is worse than none', () => {
    // the convention is an index, not a dump; past a few hundred lines nobody
    // re-reads it and it quietly stops describing the thing
    expect(source.split('\n').length).toBeLessThan(300);
  });
});

/**
 * Every block in an HTML export can be linked to.
 *
 * @remarks
 * `blockAttrs` gives every built-in block `id="<blockId>"` — that is what the
 * table of contents anchors at, and the property the docs state as "les ancres
 * sont les identifiants de blocs, ceux que l'export HTML émet déjà". A plugin
 * returns its own markup instead, and all five of them were returning it
 * without an id: a callout, a code block, an embed, a drop zone or an MDX
 * component was the one kind of block a link into an export could not reach.
 *
 * Checked by rendering rather than by reading the source, because what matters
 * is the string that comes out.
 */
describe('the HTML export gives every block an anchor', () => {
  it('built-in and plugin blocks alike carry their id', async () => {
    const { renderToHTML } = await import('../packages/static-renderer/src/index');
    const { PluginRegistry } = await import('../packages/core/src/index');
    const { calloutPlugin } = await import('../packages/blocks-callout/src/index');
    const { mdxPlugin } = await import('../packages/blocks-mdx/src/index');
    const { embedPlugin } = await import('../packages/blocks-embed/src/index');
    const { dropZonePlugin } = await import('../packages/blocks-dropzone/src/index');
    const { tocPlugin } = await import('../packages/blocks-toc/src/index');

    const plugins = new PluginRegistry().registerAll([
      calloutPlugin,
      mdxPlugin,
      embedPlugin,
      dropZonePlugin,
      tocPlugin,
    ]);

    const blocks: BlockJSON[] = [
      { id: 'b-para', type: 'paragraph', version: 1, text: [{ text: 'du texte' }] },
      { id: 'b-callout', type: 'callout', version: 1, props: { icon: '💡' }, text: [{ text: 'note' }] },
      { id: 'b-mdx', type: 'mdx_component', version: 1, props: { source: '<Counter start={6} />' }, text: [] },
      { id: 'b-embed', type: 'embed', version: 1, props: { src: 'https://example.com', mode: 'card' }, text: [] },
      { id: 'b-drop', type: 'drop_zone', version: 1, props: { files: [] }, text: [] },
      { id: 'b-toc', type: 'table_of_contents', version: 1, text: [] },
    ];
    const html = renderToHTML({ id: 'root', type: 'page', version: 1, children: blocks }, { plugins });

    for (const block of blocks) {
      expect(html, `${block.type} should carry its id`).toContain(`id="${block.id}"`);
    }
  });

  it('an MDX component exports its source, state included, and runs nothing', async () => {
    const { renderToHTML } = await import('../packages/static-renderer/src/index');
    const { PluginRegistry } = await import('../packages/core/src/index');
    const { mdxPlugin } = await import('../packages/blocks-mdx/src/index');
    const plugins = new PluginRegistry().registerAll([mdxPlugin]);
    const html = renderToHTML(
      {
        id: 'root',
        type: 'page',
        version: 1,
        children: [
          { id: 'm', type: 'mdx_component', version: 1, props: { source: '<Counter start={6} />' }, text: [] },
        ],
      },
      { plugins },
    );

    // the state rides in the tag, so the export carries it — as text, escaped,
    // which is the same promise the editor makes: shown, never run
    expect(html).toContain('&lt;Counter start={6} /&gt;');
    expect(html).not.toContain('<Counter');
  });
});
