import { describe, expect, it } from 'vitest';
import type { BlockJSON } from '@nbe/core';
import { renderBlocksToHTML, renderToHTML, renderToText, runsToHtml } from '../src/index';

let n = 0;
const b = (type: string, text?: string, props?: Record<string, unknown>, children?: BlockJSON[]): BlockJSON => ({
  id: `b${n++}`,
  type,
  version: 1,
  ...(props ? { props } : {}),
  ...(text !== undefined ? { text: [{ text }] } : {}),
  ...(children ? { children } : {}),
});

describe('inline marks', () => {
  it('renders marks, links and escapes text', () => {
    const html = runsToHtml([
      { text: 'a < b & ' },
      { text: 'gras', marks: [{ type: 'bold' }] },
      { text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://x.dev?a=1&b=2' } }] },
    ]);
    expect(html).toContain('a &lt; b &amp; ');
    expect(html).toContain('<strong class="nbe-m-bold">gras</strong>');
    expect(html).toContain('href="https://x.dev?a=1&amp;b=2"');
  });

  it('projects colours as palette classes, never frozen CSS values', () => {
    const html = runsToHtml([
      { text: 'rouge', marks: [{ type: 'color', attrs: { color: 'red' } }] },
      { text: 'surligné', marks: [{ type: 'background', attrs: { color: 'yellow' } }] },
    ]);
    expect(html).toContain('class="nbe-m-color nbe-color-red"');
    expect(html).toContain('class="nbe-m-background nbe-bg-yellow"');
    expect(html).not.toContain('style=');
  });

  it('block colour and tint become classes on the block element', () => {
    const html = renderBlocksToHTML([b('paragraph', 'x', { color: 'blue', backgroundColor: 'gray' })]);
    expect(html).toContain('nbe-color-blue');
    expect(html).toContain('nbe-bg-gray');
  });

  it('nests combined marks and turns newlines into <br>', () => {
    const html = runsToHtml([{ text: 'x\ny', marks: [{ type: 'bold' }, { type: 'italic' }] }]);
    expect(html).toContain('<br>');
    expect(html.match(/<(strong|em)/g)).toHaveLength(2);
  });
});

describe('block rendering', () => {
  it('groups consecutive list items into one list, splits on type change', () => {
    const html = renderBlocksToHTML([
      b('bulleted_list_item', 'un'),
      b('bulleted_list_item', 'deux'),
      b('numbered_list_item', 'a'),
      b('to_do', 'tâche', { checked: true }),
      b('paragraph', 'fin'),
      b('bulleted_list_item', 'seul'),
    ]);
    expect(html.match(/<ul/g)).toHaveLength(3); // bullets, to-do list, trailing bullet
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<\/ul>/g)).toHaveLength(3);
    expect(html).toContain('<input type="checkbox" disabled checked>');
    // the paragraph closed the previous list
    expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('<p'));
  });

  it('renders headings, quote, callout and divider', () => {
    const html = renderBlocksToHTML([
      b('heading', 'Titre', { level: 2 }),
      b('quote', 'cité'),
      b('callout', 'note', { icon: '⚠️' }),
      b('divider'),
    ]);
    expect(html).toContain('<h2');
    expect(html).toContain('<blockquote');
    expect(html).toContain('⚠️');
    expect(html).toContain('<hr');
  });

  it('toggle becomes <details> honoring collapsed', () => {
    const open = renderBlocksToHTML([b('toggle', 'ouvert', {}, [b('paragraph', 'enfant')])]);
    expect(open).toContain('<details');
    expect(open).toContain(' open>');
    expect(open).toContain('<summary>ouvert</summary>');
    expect(open).toContain('enfant');
    const closed = renderBlocksToHTML([b('toggle', 'fermé', { collapsed: true })]);
    expect(closed).not.toContain(' open>');
  });

  it('columns nest as divs, nested children render inside their parent', () => {
    const html = renderBlocksToHTML([
      b('column_list', undefined, {}, [
        b('column', undefined, { ratio: 2 }, [b('paragraph', 'gauche')]),
        b('column', undefined, {}, [b('paragraph', 'droite')]),
      ]),
    ]);
    expect(html).toContain('nbe-t-column_list');
    expect(html).toContain('flex-grow:2');
    expect(html.indexOf('gauche')).toBeLessThan(html.indexOf('droite'));
  });

  it('resolves assets and page links through options', () => {
    const html = renderBlocksToHTML(
      [b('image', undefined, { src: 'asset:abc', caption: 'photo' }), b('link_to_page', undefined, { pageId: 'p1', title: 'Cible' })],
      { resolveAssetUrl: (s) => `/files/${s.slice(6)}.png`, resolvePageHref: (id) => `/p/${id}` },
    );
    expect(html).toContain('src="/files/abc.png"');
    expect(html).toContain('<figcaption>photo</figcaption>');
    expect(html).toContain('href="/p/p1"');
  });

  it('database blocks delegate to the host renderer, unknown types survive', () => {
    const withDb = renderBlocksToHTML([b('database', undefined, { collectionId: 'c1', viewId: 'v1' })], {
      renderDatabase: (c, v) => `<table data-c="${c}" data-v="${v}"></table>`,
    });
    expect(withDb).toContain('data-c="c1"');
    expect(renderBlocksToHTML([b('database', undefined, { collectionId: 'c1' })])).toBe('');
    const unknown = renderBlocksToHTML([b('mystery', 'contenu')]);
    expect(unknown).toContain('data-unknown-type="mystery"');
    expect(unknown).toContain('contenu');
  });

  it('renderToHTML wraps a page and blockIds can be disabled', () => {
    const page = b('page', undefined, {}, [b('paragraph', 'salut')]);
    expect(renderToHTML(page)).toMatch(/^<div class="nbe-page"><p id="b\d+"/);
    expect(renderToHTML(page, { blockIds: false })).not.toContain('id="');
    expect(renderToHTML(page, { classPrefix: 'x' })).toContain('class="x-page"');
  });

  it('renderToText flattens the tree for previews and indexes', () => {
    const page = b('page', undefined, {}, [b('heading', 'Titre'), b('paragraph', 'corps', {}, [b('paragraph', 'enfant')])]);
    expect(renderToText(page)).toBe('Titre\ncorps\nenfant');
  });

  it('is SSR-safe: no DOM globals touched', () => {
    // the module is imported in a node environment (no document/window) —
    // reaching this assertion at all proves the renderer never touches them
    expect(typeof globalThis.document).toBe('undefined');
    expect(renderBlocksToHTML([b('paragraph', 'ok')])).toContain('ok');
  });
});
