import { describe, expect, it } from 'vitest';
import type { BlockJSON } from '@nbe/core';
import { PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { renderToHTML } from '@nbe/static-renderer';
import { TOC_MARKER, tocBlocks, tocEntries, tocPlugin } from '../src/index';

function b(type: string, extra: Partial<Omit<BlockJSON, 'id' | 'type' | 'version'>> = {}, id = 'x'): BlockJSON {
  return { id, type, version: 1, ...extra };
}

const plugins = new PluginRegistry().registerAll(tocBlocks);

const page: BlockJSON = b('page', {
  props: { title: 'Page' },
  children: [
    b('table_of_contents', {}, 'toc-1'),
    b('heading', { props: { level: 1 }, text: [{ text: 'Un' }] }, 'h-1'),
    b('paragraph', { text: [{ text: 'du texte' }] }, 'p-1'),
    b('heading', { props: { level: 2 }, text: [{ text: 'Un.un' }] }, 'h-2'),
    b('heading', { props: { level: 3 }, text: [{ text: '' }] }, 'h-empty'),
    b('toggle', { text: [{ text: 'replié' }], children: [b('heading', { props: { level: 2 }, text: [{ text: 'Dedans' }] }, 'h-3')] }, 't-1'),
  ],
}, 'page-1');

describe('the headings it lists', () => {
  it('reads them in document order, with their level', () => {
    expect(tocEntries((page.children ?? []) as never)).toEqual([
      { id: 'h-1', level: 1, text: 'Un' },
      { id: 'h-2', level: 2, text: 'Un.un' },
      { id: 'h-3', level: 2, text: 'Dedans' },
    ]);
  });

  it('skips an empty heading rather than listing a link to nothing', () => {
    expect(tocEntries((page.children ?? []) as never).map((e) => e.id)).not.toContain('h-empty');
  });

  it('clamps a level outside 1–3, because the anchor still has to render', () => {
    const odd = [b('heading', { props: { level: 9 }, text: [{ text: 'trop bas' }] }, 'h')];
    expect(tocEntries(odd as never)[0]!.level).toBe(3);
  });
});

describe('markdown', () => {
  it('writes and reads `[TOC]`', () => {
    const md = blocksToMarkdown([b('table_of_contents')], { plugins });
    expect(md).toBe(TOC_MARKER);
    expect(markdownToBlocks(md, { plugins })[0]!.type).toBe('table_of_contents');
  });

  it('round-trips inside a page without swallowing what follows', () => {
    const src = '[TOC]\n\n# Un\n\ndu texte';
    const blocks = markdownToBlocks(src, { plugins });
    expect(blocks.map((x) => x.type)).toEqual(['table_of_contents', 'heading', 'paragraph']);
    expect(blocksToMarkdown(blocks, { plugins })).toBe(src);
  });
});

describe('static html', () => {
  it('links to the heading ids the renderer emits', () => {
    const html = renderToHTML(page, { plugins });
    expect(html).toContain('<a href="#h-1">Un</a>');
    expect(html).toContain('<a href="#h-2">Un.un</a>');
    // and the anchors it points at are really there
    expect(html).toContain('id="h-1"');
    expect(html).toContain('id="h-2"');
  });

  it('renders an empty nav rather than inventing a list when it has no page', () => {
    const html = tocPlugin.html!(b('table_of_contents') as never, { depth: 0, child: () => [] });
    expect(html).toContain('<ul></ul>');
  });

  it('escapes a heading that contains markup', () => {
    const hostile = b('page', {
      children: [
        b('table_of_contents', {}, 'toc'),
        b('heading', { props: { level: 1 }, text: [{ text: '<script>x</script>' }] }, 'h'),
      ],
    });
    expect(renderToHTML(hostile, { plugins })).not.toContain('<script>x</script></a>');
  });
});
