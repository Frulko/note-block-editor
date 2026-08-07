/**
 * The human-readable projection: markdown in both directions, plus CSV
 * and Obsidian-shaped view files for collections. Depends on core only.
 *
 * @module @nbe/markdown
 */

import type { Block, BlockJSON, Mark, MarkdownRule, PluginRegistry, Run } from '@nbe/core';
import { uuidv7 } from '@nbe/core';

// ---------------------------------------------------------------------------
// Inline: runs → markdown
// ---------------------------------------------------------------------------

/** Escape markdown control chars in plain text so it survives a round-trip. */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_~[\]]/g, (c) => '\\' + c);
}

export function runsToMarkdown(runs: Run[] | undefined): string {
  return (runs ?? []).map(runToMarkdown).join('');
}

function runToMarkdown(run: Run): string {
  const marks = run.marks ?? [];
  const has = (t: string) => marks.some((m) => m.type === t);
  let s: string;
  if (has('code')) {
    // ponytail: code content emitted raw; a backtick inside a code run breaks — use runs without backticks in code
    s = '`' + run.text + '`';
  } else {
    s = escapeMd(run.text);
    if (has('bold')) s = `**${s}**`;
    if (has('italic')) s = `*${s}*`;
    if (has('strike')) s = `~~${s}~~`;
    if (has('underline')) s = `<u>${s}</u>`; // no markdown equivalent
  }
  const link = marks.find((m) => m.type === 'link');
  if (link) s = `[${s}](${String(link.attrs?.['href'] ?? '')})`;
  return s;
}

// ---------------------------------------------------------------------------
// Inline: markdown → runs (simple tokenizer, not a CommonMark parser)
// ---------------------------------------------------------------------------

export function markdownToRuns(text: string): Run[] {
  return parseInline(text, []);
}

const DELIMS: [string, string[]][] = [
  ['***', ['bold', 'italic']],
  ['**', ['bold']],
  ['~~', ['strike']],
  ['*', ['italic']],
  ['_', ['italic']],
];

function parseInline(text: string, marks: Mark[]): Run[] {
  const runs: Run[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push(marks.length ? { text: buf, marks: marks.map((m) => ({ ...m })) } : { text: buf });
      buf = '';
    }
  };

  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i]!;

    // backslash escape
    if (ch === '\\' && i + 1 < text.length && /[^A-Za-z0-9\s]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // code span: no nesting inside
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        runs.push({ text: text.slice(i + 1, close), marks: [...marks.map((m) => ({ ...m })), { type: 'code' }] });
        i = close + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // link
    if (ch === '[') {
      const lm = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (lm) {
        flush();
        runs.push(...parseInline(lm[1]!, [...marks, { type: 'link', attrs: { href: lm[2]! } }]));
        i += lm[0].length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // emphasis delimiters; unmatched markers stay literal
    for (const [d, types] of DELIMS) {
      if (text.startsWith(d, i)) {
        let close = text.indexOf(d, i + d.length);
        // when the closer sits inside a longer run (e.g. `**a *b***`), take its rightmost end
        while (close > 0 && text[close + d.length] === d[0]) close++;
        if (close > i + d.length) {
          flush();
          runs.push(...parseInline(text.slice(i + d.length, close), [...marks, ...types.map((t) => ({ type: t }))]));
          i = close + d.length;
          continue outer;
        }
        break; // matched prefix but no closer → literal
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return runs;
}

// ---------------------------------------------------------------------------
// Blocks → markdown
// ---------------------------------------------------------------------------

const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle']);

/**
 * Options carried through a whole serialization or parse.
 *
 * @remarks
 * `plugins` is passed per call rather than held in a module registry, for the
 * same reason the editor's registry is per instance: two documents in one
 * process may legitimately use different block sets, and a module-level map
 * makes that impossible.
 *
 * @category Projections
 */
export interface MarkdownOptions {
  /** Block plugins whose markdown projections should be consulted first. */
  plugins?: PluginRegistry;
}

/**
 * Serialize blocks to markdown.
 *
 * @param blocks - Top-level blocks, in document order.
 * @param opts - Plugin projections to consult before the built-in handling.
 *
 * @category Projections
 */
export function blocksToMarkdown(blocks: BlockJSON[], opts: MarkdownOptions = {}): string {
  const groups = blocks.map((b) => ({ lines: renderBlock(b, 0, opts), list: LIST_TYPES.has(b.type) }));
  let out = '';
  groups.forEach((g, idx) => {
    if (g.lines.length === 0) return;
    // blank line between top-level blocks except between consecutive list items
    if (out) out += g.list && groups[idx - 1]?.list ? '\n' : '\n\n';
    out += g.lines.join('\n');
  });
  return out;
}

function renderBlock(b: BlockJSON, depth: number, opts: MarkdownOptions = {}): string[] {
  // a plugin's projection wins over the built-in switch; the switch is what
  // the block types not yet extracted still use
  const projection = opts.plugins?.get(b.type)?.markdown;
  if (projection) {
    return projection.toMarkdown(b as unknown as Block, {
      depth,
      child: (child) => renderBlock(child as unknown as BlockJSON, 0, opts),
    });
  }
  const pad = '    '.repeat(depth);
  const p = b.props ?? {};
  const text = runsToMarkdown(b.text);
  const kids = () => (b.children ?? []).flatMap((c) => renderBlock(c, depth + 1, opts));
  // quote/callout children are rendered un-indented then '> '-prefixed
  const quotedKids = () => (b.children ?? []).flatMap((c) => renderBlock(c, 0, opts)).map((l) => pad + '> ' + l);

  switch (b.type) {
    case 'paragraph':
      return [pad + text, ...kids()];
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(p['level'] ?? 1)));
      return [pad + '#'.repeat(level) + ' ' + text, ...kids()];
    }
    case 'bulleted_list_item':
      return [pad + '- ' + text, ...kids()];
    case 'numbered_list_item':
      return [pad + '1. ' + text, ...kids()]; // always "1.": renderers renumber
    case 'to_do':
      return [pad + (p['checked'] === true ? '- [x] ' : '- [ ] ') + text, ...kids()];
    case 'toggle':
      // documented loss: toggle-ness is lost — serialized as a plain list item with indented children
      return [pad + '- ' + text, ...kids()];
    case 'quote':
      return [pad + '> ' + text, ...quotedKids()];
    case 'callout': {
      // Obsidian callout convention: the variant IS the callout type, so
      // presets round-trip as `> [!warning]` instead of collapsing to note
      const variant = typeof p['variant'] === 'string' && p['variant'] ? p['variant'] : 'note';
      const icon = typeof p['icon'] === 'string' && p['icon'] ? p['icon'] + ' ' : '';
      return [pad + `> [!${variant}] ` + icon + text, ...quotedKids()];
    }
    case 'code': {
      const lang = typeof p['language'] === 'string' ? p['language'] : '';
      const raw = (b.text ?? []).map((r) => r.text).join('');
      return [pad + '```' + lang, ...(raw ? raw.split('\n').map((l) => pad + l) : []), pad + '```'];
    }
    case 'divider':
      return [pad + '---'];
    case 'image':
      return [pad + `![${text}](${String(p['src'] ?? '')})`];
    case 'link_to_page':
      return [pad + `[[${String(p['title'] || 'page')}]]`];
    case 'table': {
      const rows = (b.children ?? []).filter((r) => r.type === 'table_row');
      if (!rows.length) return [];
      const cells = (row: BlockJSON) =>
        (row.children ?? [])
          .filter((c) => c.type === 'table_cell')
          // a pipe inside a cell would end the cell, so it has to be escaped
          .map((c) => runsToMarkdown(c.text).replace(/\|/g, '\\|').replace(/\n/g, ' '));
      const width = Math.max(...rows.map((r) => cells(r).length));
      const line = (values: string[]) =>
        pad + '| ' + Array.from({ length: width }, (_, i) => values[i] ?? '').join(' | ') + ' |';
      // GFM has no headerless table: without a header row we emit an empty one,
      // which renders as a thin blank strip rather than promoting real data
      const header = p['headerRow'] === false ? [] : cells(rows[0]!);
      const body = p['headerRow'] === false ? rows : rows.slice(1);
      return [
        line(header),
        pad + '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |',
        ...body.map((r) => line(cells(r))),
      ];
    }
    case 'column_list':
      // documented loss: column layout is lost — columns' contents flattened sequentially
      return (b.children ?? []).flatMap((col) => (col.children ?? []).flatMap((c) => renderBlock(c, depth)));
    default:
      // unknown type: marker comment so nothing silently disappears, then children
      return [pad + `<!-- nbe:${b.type} -->`, ...(b.children ?? []).flatMap((c) => renderBlock(c, depth))];
  }
}

// ---------------------------------------------------------------------------
// Markdown → blocks (line-based, line = block, like Notion paste)
// ---------------------------------------------------------------------------

/**
 * Parse markdown into blocks.
 *
 * @param text - Markdown source.
 * @param opts - Plugin projections whose `fromMarkdown` rules are tried first.
 *
 * @category Projections
 */
export function markdownToBlocks(text: string, opts: MarkdownOptions = {}): BlockJSON[] {
  const [blocks] = parseLevel(text.split(/\r?\n/), 0, 0, opts);
  return blocks;
}

/** Every contributed rule, flattened once per parse. */
function contributedRules(opts: MarkdownOptions): Array<{ type: string; rule: MarkdownRule }> {
  const out: Array<{ type: string; rule: MarkdownRule }> = [];
  for (const plugin of opts.plugins?.all() ?? []) {
    for (const rule of plugin.markdown?.fromMarkdown ?? []) out.push({ type: plugin.schema.type, rule });
  }
  return out;
}

function mk(type: string, props: Record<string, unknown>, text?: Run[], children?: BlockJSON[]): BlockJSON {
  const b: BlockJSON = { id: uuidv7(), type, version: 1 };
  if (Object.keys(props).length) b.props = props;
  if (text?.length) b.text = text;
  if (children?.length) b.children = children;
  return b;
}

/** Indent depth in levels: one tab or 4 spaces per level. */
function indentLevel(line: string): number {
  let level = 0;
  let spaces = 0;
  for (const ch of line) {
    if (ch === '\t') {
      level++;
      spaces = 0;
    } else if (ch === ' ') {
      if (++spaces === 4) {
        level++;
        spaces = 0;
      }
    } else break;
  }
  return level;
}

/** Remove up to `levels` levels of leading indentation (tab or 4 spaces each). */
function stripLevels(line: string, levels: number): string {
  let i = 0;
  for (let l = 0; l < levels && i < line.length; l++) {
    if (line[i] === '\t') i++;
    else {
      let s = 0;
      while (s < 4 && line[i] === ' ') {
        i++;
        s++;
      }
      if (s === 0) break;
    }
  }
  return line.slice(i);
}

/** `| --- | :-: |` — the row that turns pipe lines into a GFM table. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return t
    .replace(/^\||\|$/g, '')
    .split('|')
    .every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/** Split a pipe row into cells, honouring `\|` escapes and optional edge pipes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      current += '\\|';
      i++;
    } else if (line[i] === '|') {
      cells.push(current);
      current = '';
    } else current += line[i];
  }
  cells.push(current);
  if (cells[0]!.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function parseLevel(
  lines: string[],
  pos: number,
  level: number,
  opts: MarkdownOptions = {},
): [BlockJSON[], number] {
  const out: BlockJSON[] = [];
  const rules = contributedRules(opts);
  while (pos < lines.length) {
    const raw = lines[pos]!;
    if (raw.trim() === '') {
      pos++;
      continue;
    }
    const ind = indentLevel(raw);
    if (ind < level) break;
    // orphan deeper indentation (not under a list item): clamp to this level
    const content = ind > level ? raw.trimStart() : stripLevels(raw, level);
    let m: RegExpExecArray | null;

    // contributed rules first: a plugin owns its own syntax
    let claimed = false;
    for (const { rule } of rules) {
      if (!rule.match.test(content)) continue;
      const parsed = rule.parse(lines.map((l) => stripLevels(l, level)), pos);
      if (!parsed) continue;
      const block = parsed.block as unknown as BlockJSON;
      out.push({ ...block, id: block.id || uuidv7() });
      pos += parsed.consumed;
      claimed = true;
      break;
    }
    if (claimed) continue;

    // code fence
    if ((m = /^```(.*)$/.exec(content))) {
      pos++;
      const body: string[] = [];
      while (pos < lines.length && !/^```\s*$/.test(stripLevels(lines[pos]!, level))) {
        body.push(stripLevels(lines[pos]!, level));
        pos++;
      }
      if (pos < lines.length) pos++; // closing fence
      const lang = m[1]!.trim();
      const code = body.join('\n');
      out.push(mk('code', lang ? { language: lang } : {}, code ? [{ text: code }] : undefined));
      continue;
    }

    // GFM table: a pipe row is only a table if the next line is the delimiter
    if (content.includes('|') && pos + 1 < lines.length && isDelimiterRow(stripLevels(lines[pos + 1]!, level))) {
      const rows = [splitRow(content)];
      pos += 2;
      while (pos < lines.length) {
        const next = stripLevels(lines[pos]!, level);
        if (!next.includes('|') || next.trim() === '') break;
        rows.push(splitRow(next));
        pos++;
      }
      const width = Math.max(...rows.map((r) => r.length));
      // an all-empty first row is the headerless marker we serialize
      const headerRow = rows[0]!.some((c) => c.trim() !== '');
      const body = headerRow ? rows : rows.slice(1);
      out.push(
        mk(
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
        ),
      );
      continue;
    }

    // divider
    if (/^-{3,}\s*$/.test(content)) {
      out.push(mk('divider', {}));
      pos++;
      continue;
    }

    // image alone on a line
    if ((m = /^!\[(.*?)\]\((.*?)\)\s*$/.exec(content))) {
      out.push(mk('image', { src: m[2]! }, m[1] ? markdownToRuns(m[1]) : undefined));
      pos++;
      continue;
    }

    // wikilink alone on a line
    if ((m = /^\[\[(.+?)\]\]\s*$/.exec(content))) {
      out.push(mk('link_to_page', { title: m[1]! }));
      pos++;
      continue;
    }

    // heading
    if ((m = /^(#{1,6})\s+(.*)$/.exec(content))) {
      out.push(mk('heading', { level: Math.min(3, m[1]!.length) }, markdownToRuns(m[2]!)));
      pos++;
      continue;
    }

    // quote / callout: gather consecutive '>' lines at this level
    if ((m = /^>\s?(.*)$/.exec(content))) {
      const quoteLines = [m[1]!];
      pos++;
      while (pos < lines.length) {
        const r = lines[pos]!;
        if (r.trim() === '' || indentLevel(r) !== level) break;
        const qm = /^>\s?(.*)$/.exec(stripLevels(r, level));
        if (!qm) break;
        quoteLines.push(qm[1]!);
        pos++;
      }
      const children = quoteLines
        .slice(1)
        .filter((l) => l.trim() !== '')
        .map((l) => mk('paragraph', {}, markdownToRuns(l)));
      const cm = /^\[!(\w+)\][-+]?\s?(.*)$/.exec(quoteLines[0]!);
      if (cm) {
        // 'note' is the default rendering, so it is never stored — that keeps
        // documents lean and makes the markdown round-trip byte-stable
        const variant = cm[1]!.toLowerCase();
        out.push(mk('callout', variant === 'note' ? {} : { variant }, markdownToRuns(cm[2]!), children));
      }
      else out.push(mk('quote', {}, markdownToRuns(quoteLines[0]!), children));
      continue;
    }

    // list items: to_do, bullet, numbered — all may have indented children
    let item: BlockJSON | null = null;
    if ((m = /^[-*] \[([ xX])\]\s?(.*)$/.exec(content))) {
      item = mk('to_do', { checked: m[1]!.toLowerCase() === 'x' }, markdownToRuns(m[2]!));
    } else if ((m = /^[-*]\s+(.*)$/.exec(content))) {
      item = mk('bulleted_list_item', {}, markdownToRuns(m[1]!));
    } else if ((m = /^\d+\.\s+(.*)$/.exec(content))) {
      item = mk('numbered_list_item', {}, markdownToRuns(m[1]!));
    }
    if (item) {
      pos++;
      let j = pos;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      if (j < lines.length && indentLevel(lines[j]!) > level) {
        const [children, next] = parseLevel(lines, j, level + 1, opts);
        if (children.length) item.children = children;
        pos = next;
      }
      out.push(item);
      continue;
    }

    // paragraph (each plain line is its own block)
    out.push(mk('paragraph', {}, markdownToRuns(content)));
    pos++;
  }
  return [out, pos];
}
