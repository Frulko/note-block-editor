import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';
import type { BlockJSON } from '@nbe/core';

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
    const md = blocksToMarkdown([table({}, row('Nom', 'Ville'), row('Ada', 'Londres'))]);
    expect(md).toBe(['| Nom | Ville |', '| --- | --- |', '| Ada | Londres |'].join('\n'));
  });

  it('pads a ragged row so the pipe grid stays rectangular', () => {
    const md = blocksToMarkdown([table({}, row('a', 'b'), row('c'))]);
    expect(md.split('\n')[2]).toBe('| c |  |');
  });

  it('escapes a pipe inside a cell', () => {
    const md = blocksToMarkdown([table({}, row('a|b', 'c'))]);
    expect(md.split('\n')[0]).toBe('| a\\|b | c |');
  });

  it('emits an empty header row when the table has no header', () => {
    const md = blocksToMarkdown([table({ headerRow: false }, row('a', 'b'))]);
    expect(md).toBe(['|  |  |', '| --- | --- |', '| a | b |'].join('\n'));
  });
});

describe('markdown → table', () => {
  it('parses a pipe table into rows and cells', () => {
    const [block] = markdownToBlocks('| Nom | Ville |\n| --- | --- |\n| Ada | Londres |');
    expect(block!.type).toBe('table');
    expect(grid(block!)).toEqual([
      ['Nom', 'Ville'],
      ['Ada', 'Londres'],
    ]);
  });

  it('needs the delimiter row — a bare pipe line stays a paragraph', () => {
    const [block] = markdownToBlocks('a | b | c');
    expect(block!.type).toBe('paragraph');
  });

  it('accepts alignment markers and missing edge pipes', () => {
    const [block] = markdownToBlocks('Nom | Ville\n:-- | --:\nAda | Londres');
    expect(grid(block!)).toEqual([
      ['Nom', 'Ville'],
      ['Ada', 'Londres'],
    ]);
  });

  it('round-trips a table through markdown and back', () => {
    const source = table({}, row('Nom', 'Ville'), row('Ada', 'Londres'), row('Grace', 'New York'));
    const [parsed] = markdownToBlocks(blocksToMarkdown([source]));
    expect(grid(parsed!)).toEqual(grid(source));
  });

  it('round-trips a headerless table', () => {
    const source = table({ headerRow: false }, row('a', 'b'), row('c', 'd'));
    const [parsed] = markdownToBlocks(blocksToMarkdown([source]));
    expect(parsed!.props).toEqual({ headerRow: false });
    expect(grid(parsed!)).toEqual(grid(source));
  });

  it('unescapes a pipe on the way back in', () => {
    const [block] = markdownToBlocks('| a\\|b | c |\n| --- | --- |\n| d | e |');
    expect(grid(block!)[0]).toEqual(['a|b', 'c']);
  });
});
