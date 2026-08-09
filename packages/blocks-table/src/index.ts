/**
 * The simple table: three block types, one plugin, no DOM.
 *
 * This entry carries everything that does not need an editing surface — the
 * schema, the geometry, the commands, the document invariants and both
 * projections — so `@nbe/markdown`, `@nbe/static-renderer` and a headless
 * import consume the table without pulling in the view. The editing behaviour
 * (rendering, cell selection, the hover chrome) lives in
 * `@nbe/blocks-table/dom`.
 *
 * Three block types rather than one, the way ProseMirror and Tiptap both do
 * it: `table`, `table_row` and `table_cell` are separate registrations because
 * each is a real block with its own id and its own history.
 *
 * @module @nbe/blocks-table
 */
import type { Block, BlockJSON, BlockPlugin, MarkdownProjection, Run } from '@nbe/core';
import { PLUGIN_API_VERSION } from '@nbe/core';
import { markdownToRuns, runsToMarkdown } from '@nbe/markdown';
import { normalizeTables } from './model';

export * from './model';

// ------------------------------------------------------------------ markdown

/** `| --- | :-: |` — the row that turns pipe lines into a GFM table. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return t
    .replace(/^\||\|$/g, '')
    .split('|')
    .every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

const mk = (type: string, props: Record<string, unknown>, text?: Run[], children?: BlockJSON[]): BlockJSON => ({
  id: '',
  type,
  version: 1,
  ...(Object.keys(props).length ? { props } : {}),
  ...(text?.length ? { text } : {}),
  ...(children?.length ? { children } : {}),
});

/**
 * GFM tables, both directions.
 *
 * @remarks
 * Lossy on purpose and by declaration: GFM has no `colSpan`/`rowSpan` and no
 * column widths, so a merged table exports as ragged rows and comes back
 * unmerged. Saying so in `lossyReason` is the contract — the failure this
 * plugin API exists to prevent is the *silent* version of exactly this.
 *
 * @category Projections
 */
export const tableMarkdown: MarkdownProjection = {
  lossyReason: 'GFM has no merged cells or column widths: spans and widths are dropped',
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const props = block.props ?? {};
    const rows = (block.children ?? []).filter((r) => (r as unknown as BlockJSON).type === 'table_row');
    if (!rows.length) return [];
    const cells = (row: unknown): string[] =>
      ((row as BlockJSON).children ?? [])
        .filter((c) => c.type === 'table_cell')
        // a pipe inside a cell would end the cell, so it has to be escaped
        .map((c) => runsToMarkdown(c.text).replace(/\|/g, '\\|').replace(/\n/g, ' '));
    const width = Math.max(...rows.map((r) => cells(r).length));
    const line = (values: string[]) =>
      pad + '| ' + Array.from({ length: width }, (_, i) => values[i] ?? '').join(' | ') + ' |';
    // GFM has no headerless table: without a header row we emit an empty one,
    // which renders as a thin blank strip rather than promoting real data
    const header = props['headerRow'] === false ? [] : cells(rows[0]!);
    const body = props['headerRow'] === false ? rows : rows.slice(1);
    return [
      line(header),
      pad + '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |',
      ...body.map((r) => line(cells(r))),
    ];
  },

  fromMarkdown: [
    {
      // a pipe row is only a table when the next line is the delimiter, which
      // the match alone cannot see — `parse` declines when it is not
      match: /\|/,
      parse(lines, start) {
        const first = lines[start] ?? '';
        if (!first.includes('|') || !isDelimiterRow(lines[start + 1] ?? '')) return null;
        const rows = [splitRow(first)];
        let consumed = 2;
        while (start + consumed < lines.length) {
          const next = lines[start + consumed] ?? '';
          if (!next.includes('|') || next.trim() === '') break;
          rows.push(splitRow(next));
          consumed++;
        }
        const width = Math.max(...rows.map((r) => r.length));
        // an all-empty first row is the headerless marker we serialize
        const headerRow = rows[0]!.some((c) => c.trim() !== '');
        const body = headerRow ? rows : rows.slice(1);
        const block = mk(
          'table',
          headerRow ? {} : { headerRow: false },
          undefined,
          body.map((cells) =>
            mk(
              'table_row',
              {},
              undefined,
              Array.from({ length: width }, (_, i) =>
                mk('table_cell', {}, markdownToRuns((cells[i] ?? '').replace(/\\\|/g, '|'))),
              ),
            ),
          ),
        );
        return { block: block as unknown as Block, consumed };
      },
    },
  ],
};

// ---------------------------------------------------------------- static HTML

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Real `<table>` markup, so an exported page stays readable and accessible. */
function tableHtml(block: Block): string {
  const props = block.props ?? {};
  const rows = ((block.children ?? []) as unknown as BlockJSON[]).filter((r) => r.type === 'table_row');
  const cellHtml = (c: BlockJSON, tag: string): string => {
    const p = c.props ?? {};
    const span = (key: string, attr: string): string => {
      const n = Number(p[key] ?? 1);
      return Number.isFinite(n) && n > 1 ? ` ${attr}="${Math.floor(n)}"` : '';
    };
    const text = (c.text ?? []).map((run) => escapeHtml(run.text)).join('');
    return `<${tag}${span('colSpan', 'colspan')}${span('rowSpan', 'rowspan')}>${text}</${tag}>`;
  };
  const rowHtml = (row: BlockJSON, tag: string) =>
    `<tr>${(row.children ?? [])
      .filter((c) => c.type === 'table_cell')
      .map((c) => cellHtml(c, tag))
      .join('')}</tr>`;
  const header = props['headerRow'] === false ? null : rows[0];
  const body = header ? rows.slice(1) : rows;
  return `<table class="nbe-t-table">${header ? `<thead>${rowHtml(header, 'th')}</thead>` : ''}<tbody>${body
    .map((r) => rowHtml(r, 'td'))
    .join('')}</tbody></table>`;
}

// ------------------------------------------------------------------- plugins

/**
 * The table itself: the grid, its invariants, and both projections.
 *
 * @remarks
 * `normalize` is the reason a table can be a plugin at all. Its invariant —
 * every row fills exactly as many slots as the widest one, counting the slots
 * a merged neighbour covers — used to be a hardwired call in the reducer.
 *
 * @category Plugins
 */
export const tablePlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'table',
    version: 1,
    inline: false,
    layout: true,
    // a container, but the unit you grab: its rows and cells are not
    standalone: true,
    defaultProps: { headerRow: true },
  },
  normalize: normalizeTables,
  markdown: tableMarkdown,
  html: tableHtml,
};

/** A row: pure structure, its cells are the grid items (see the `/dom` entry). */
export const tableRowPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: { type: 'table_row', version: 1, inline: false, layout: true, standalone: false },
  // rows and cells are rendered *by* the table, so their projections are the
  // table's; declaring nothing here is what makes that explicit rather than
  // accidental
  markdown: { toMarkdown: () => [], fromMarkdown: [], lossyReason: 'rows are serialized by their table' },
};

/** A cell: inline text, plus `colSpan`/`rowSpan` when it has been merged. */
export const tableCellPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: { type: 'table_cell', version: 1, inline: true, standalone: false },
  markdown: { toMarkdown: () => [], fromMarkdown: [], lossyReason: 'cells are serialized by their table' },
};

/**
 * The three block types, ready to register.
 *
 * @example
 * ```ts
 * import { tableBlocks } from '@nbe/blocks-table'
 * const editor = new Editor({ plugins: tableBlocks })
 * ```
 *
 * @category Plugins
 */
export const tableBlocks: BlockPlugin[] = [tablePlugin, tableRowPlugin, tableCellPlugin];
