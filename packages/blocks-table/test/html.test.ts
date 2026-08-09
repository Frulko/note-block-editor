import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@nbe/core';
import { renderBlocksToHTML } from '@nbe/static-renderer';
import { tableBlocks } from '../src/index';

/*
 * The static HTML projection, through the plugin path. `@nbe/static-renderer`
 * has no table case left: it consults `plugin.html` first, and falls back to a
 * marker for anything it does not know — which is what makes an unregistered
 * block visible instead of silently dropped.
 */
const plugins = new PluginRegistry().registerAll(tableBlocks);
const render = (blocks: unknown[]) => renderBlocksToHTML(blocks as never, { plugins });

describe('table', () => {
  const cell = (t: string) => ({ id: 'c' + t, type: 'table_cell', version: 1, text: [{ text: t }] });
  const row = (...t: string[]) => ({ id: 'r' + t[0], type: 'table_row', version: 1, children: t.map(cell) });

  it('renders real table markup with a thead', () => {
    const html = render([
      { id: 't', type: 'table', version: 1, children: [row('Nom', 'Ville'), row('Ada', 'Londres')] },
    ] as never);
    expect(html).toContain('<thead>');
    expect(html).toContain('<th');
    expect(html).toContain('Ada');
    expect(html.match(/<tr/g)).toHaveLength(2);
  });

  it('skips the thead when the table has no header row', () => {
    const html = render([
      { id: 't', type: 'table', version: 1, props: { headerRow: false }, children: [row('a', 'b')] },
    ] as never);
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th');
  });
});
