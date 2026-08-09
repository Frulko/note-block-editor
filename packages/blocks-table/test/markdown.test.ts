import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { PluginRegistry, type BlockJSON } from '@nbe/core';
import { tableBlocks } from '../src/index';

/*
 * The table's markdown projection, exercised through the *plugin* path: the
 * markdown package no longer knows what a table is, so a host that does not
 * register the plugin gets the honest marker comment instead of a table.
 */
const plugins = new PluginRegistry().registerAll(tableBlocks);
const blocksToMarkdown_ = (blocks: BlockJSON[]) => blocksToMarkdown(blocks, { plugins });
const markdownToBlocks_ = (text: string) => markdownToBlocks(text, { plugins });

const cell = (text: string): BlockJSON => ({
  id: 'c',
  type: 'table_cell',
  version: 1,
  ...(text ? { text: [{ text }] } : {}),
});
const row = (...texts: string[]): BlockJSON => ({
  id: 'r',
  type: 'table_row',
  version: 1,
  children: texts.map(cell),
});
const table = (props: Record<string, unknown>, ...rows: BlockJSON[]): BlockJSON => ({
  id: 't',
  type: 'table',
  version: 1,
  ...(Object.keys(props).length ? { props } : {}),
  children: rows,
});

/** Cell text of a parsed table, so assertions read like the grid itself. */
function grid(block: BlockJSON): string[][] {
  return (block.children ?? []).map((r) =>
    (r.children ?? []).map((c) => (c.text ?? []).map((run) => run.text).join('')),
  );
}

describe('table → markdown', () => {
  it('writes a GFM pipe table with a delimiter row', () => {
    const md = blocksToMarkdown_([table({}, row('Nom', 'Ville'), row('Ada', 'Londres'))]);
    expect(md).toBe(['| Nom | Ville |', '| --- | --- |', '| Ada | Londres |'].join('\n'));
  });

  it('pads a ragged row so the pipe grid stays rectangular', () => {
    const md = blocksToMarkdown_([table({}, row('a', 'b'), row('c'))]);
    expect(md.split('\n')[2]).toBe('| c |  |');
  });

  it('escapes a pipe inside a cell', () => {
    const md = blocksToMarkdown_([table({}, row('a|b', 'c'))]);
    expect(md.split('\n')[0]).toBe('| a\\|b | c |');
  });

  it('emits an empty header row when the table has no header', () => {
    const md = blocksToMarkdown_([table({ headerRow: false }, row('a', 'b'))]);
    expect(md).toBe(['|  |  |', '| --- | --- |', '| a | b |'].join('\n'));
  });
});

describe('markdown → table', () => {
  it('parses a pipe table into rows and cells', () => {
    const [block] = markdownToBlocks_('| Nom | Ville |\n| --- | --- |\n| Ada | Londres |');
    expect(block!.type).toBe('table');
    expect(grid(block!)).toEqual([
      ['Nom', 'Ville'],
      ['Ada', 'Londres'],
    ]);
  });

  it('needs the delimiter row — a bare pipe line stays a paragraph', () => {
    const [block] = markdownToBlocks_('a | b | c');
    expect(block!.type).toBe('paragraph');
  });

  it('accepts alignment markers and missing edge pipes', () => {
    const [block] = markdownToBlocks_('Nom | Ville\n:-- | --:\nAda | Londres');
    expect(grid(block!)).toEqual([
      ['Nom', 'Ville'],
      ['Ada', 'Londres'],
    ]);
  });

  it('round-trips a table through markdown and back', () => {
    const source = table({}, row('Nom', 'Ville'), row('Ada', 'Londres'), row('Grace', 'New York'));
    const [parsed] = markdownToBlocks_(blocksToMarkdown_([source]));
    expect(grid(parsed!)).toEqual(grid(source));
  });

  it('round-trips a headerless table', () => {
    const source = table({ headerRow: false }, row('a', 'b'), row('c', 'd'));
    const [parsed] = markdownToBlocks_(blocksToMarkdown_([source]));
    expect(parsed!.props).toEqual({ headerRow: false });
    expect(grid(parsed!)).toEqual(grid(source));
  });

  it('unescapes a pipe on the way back in', () => {
    const [block] = markdownToBlocks_('| a\\|b | c |\n| --- | --- |\n| d | e |');
    expect(grid(block!)[0]).toEqual(['a|b', 'c']);
  });
});

describe('the table as a construct of the host document', () => {
  it('round-trips a note byte for byte', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(blocksToMarkdown_(markdownToBlocks_(md)).trim()).toBe(md);
  });

  it('ends the paragraph above it', () => {
    // the parser asks the *rule* whether a line starts a construct, because a
    // pipe row is only a table when the delimiter follows — a plugin's
    // one-line `match` cannot see that, and `parse` is the authority
    const blocks = markdownToBlocks_('Du texte\na | b\n--- | ---\n1 | 2');
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]!.type).toBe('paragraph');
    expect(blocks[1]!.type).toBe('table');
  });

  it('is a marker comment when the plugin is not registered', () => {
    // the failure this whole contract exists to prevent is the *silent* one
    const md = blocksToMarkdown([table({}, row('a', 'b'))]);
    expect(md).toContain('<!-- nbe:table -->');
  });
});
