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

/**
 * A title reduced to what a filename and a wikilink target can both hold.
 *
 * @remarks
 * Lives here, beside the code that writes wikilinks, because the two
 * constraints are one constraint. A vault names a page `<Title>.md` and refers
 * to it as `[[Title]]`, and a reader resolves the second against the first —
 * so a title containing `/` or `:`, illegal in a filename, must lose them in
 * *both* or the link points at nothing.
 *
 * Also strips `[ ] | # ^`, which are wikilink syntax rather than filesystem
 * trouble: unescaped, they would end the link early.
 */
export function slugify(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60) || 'sans-titre';
}

/**
 * A wikilink that resolves *and* reads as the page is really called.
 *
 * @remarks
 * A vault reader matches `[[target]]` against filenames, so the target must be
 * the slug. But a page called `Réunion : 2026/07` should not be shown as
 * `Réunion 2026 07` merely because a filesystem cannot hold a slash — so when
 * the two differ, the alias form `[[target|display]]` carries both. Obsidian
 * follows the target and shows the display text, which is exactly the split we
 * need, and the parser reads the display half back as the title.
 *
 * The plain form is emitted when nothing was lost, which is almost always —
 * `[[Notes|Notes]]` would be noise in a file meant to be read by a person.
 */
function wikilink(title: string): string {
  const target = slugify(title);
  return target === title ? `[[${title}]]` : `[[${target}|${title}]]`;
}

/**
 * Serialize inline runs to markdown.
 *
 * @remarks
 * A newline inside inline text is a Shift+Enter line break, which is content.
 * A bare newline in markdown is a *soft* break that renderers collapse to a
 * space, so emitting one loses the break — the parser would read it back as
 * a space. CommonMark's hard break (a trailing backslash) is what survives.
 *
 * @category Projections
 */
/**
 * Serialize rich text.
 *
 * @remarks
 * Runs that share a mark are merged before anything is emitted. Without that,
 * `~~Notion *Enhanced Markdown*~~` came back as
 * `~~Notion ~~~~*Enhanced Markdown*~~` — the strike closed at the italic's
 * boundary and immediately reopened, which then re-parsed as literal tildes.
 * Any mark that spans a formatting change had the same fault; a heading in
 * `docs/ROADMAP.md` is what finally exposed it, through the round-trip test.
 *
 * The merge is per *mark*, not per run: a run is a storage detail, and where a
 * mark starts and stops is the only thing Markdown can express.
 */
export function runsToMarkdown(runs: Run[] | undefined): string {
  return emitRuns(runs ?? []).replace(/\n/g, '\\\n');
}

/** The mark types that wrap text, in the order they nest. */
const WRAPPERS: Array<{ type: string; open: string; close: string }> = [
  { type: 'strike', open: '~~', close: '~~' },
  { type: 'bold', open: '**', close: '**' },
  { type: 'italic', open: '*', close: '*' },
  { type: 'underline', open: '<u>', close: '</u>' }, // no markdown equivalent
];

/** True when both runs carry the same mark of this type, with the same attrs. */
function sameMark(a: Run, b: Run, type: string): boolean {
  const find = (run: Run) => (run.marks ?? []).find((m) => m.type === type);
  const one = find(a);
  const two = find(b);
  if (!one || !two) return false;
  return JSON.stringify(one.attrs ?? {}) === JSON.stringify(two.attrs ?? {});
}

function emitRuns(runs: Run[]): string {
  let out = '';
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const marks = run.marks ?? [];
    const has = (type: string) => marks.some((m) => m.type === type);

    // code, mentions and links are atomic: they wrap one run and nothing else
    if (has('code') || has('mention') || has('link')) {
      out += atomicRun(run);
      continue;
    }

    // the outermost wrapper this run has that the next runs also share
    const wrapper = WRAPPERS.find((w) => has(w.type));
    if (!wrapper) {
      out += escapeMd(run.text);
      continue;
    }

    let end = i;
    while (end + 1 < runs.length && sameMark(run, runs[end + 1]!, wrapper.type)) end++;
    // strip the mark we are about to emit, and recurse on what is left
    const inner = runs.slice(i, end + 1).map((r) => ({
      ...r,
      marks: (r.marks ?? []).filter((m) => m.type !== wrapper.type),
    }));
    out += wrapper.open + emitRuns(inner) + wrapper.close;
    i = end;
  }
  return out;
}

/** A run whose mark cannot span its neighbours. */
function atomicRun(run: Run): string {
  const marks = run.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);

  /*
   * A mention becomes a wikilink, which is what makes it survive an export:
   * `[[Title]]` is meaningful in Obsidian and readable everywhere else. The
   * page id is lost — wikilinks resolve by title — and that is the documented
   * trade. Re-import matches the title back to a page, which is exactly how
   * Obsidian itself behaves when a note is renamed.
   */
  if (has('mention')) return wikilink(run.text);

  let s: string;
  if (has('code')) {
    // ponytail: code content emitted raw; a backtick inside a code run breaks — use runs without backticks in code
    s = '`' + run.text + '`';
  } else {
    s = escapeMd(run.text);
    for (const wrapper of [...WRAPPERS].reverse()) {
      if (has(wrapper.type)) s = wrapper.open + s + wrapper.close;
    }
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

    // inline wikilink → mention. Checked before the link rule, since `[[` also
    // starts `[`, and a lone wikilink on its own line is handled as a block.
    if (ch === '[' && text[i + 1] === '[') {
      const wm = /^\[\[([^\]]+)\]\]/.exec(text.slice(i));
      if (wm) {
        flush();
        // `[[target|display]]` — the display half is the title, which is what
        // a mention shows and what a vault import matches a page against
        const shown = wm[1]!.slice(wm[1]!.indexOf('|') + 1);
        runs.push({ text: shown, marks: [...marks.map((m) => ({ ...m })), { type: 'mention' }] });
        i += wm[0].length;
        continue;
      }
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
  return renderSiblingLines(blocks, 0, opts).join('\n');
}

/**
 * Render a sibling list into lines, blank-separated where markdown needs it.
 *
 * @remarks
 * Consecutive list items are written tight; everything else gets a blank line
 * between it and its neighbour. That rule used to live only at the top level,
 * so a paragraph nested after a nested list item was written straight against
 * it — and reading the file back swallowed the paragraph into the item as a
 * lazy continuation. Same rule at every depth, in one place.
 */
function renderSiblingLines(list: BlockJSON[], depth: number, opts: MarkdownOptions): string[] {
  const rendered = renderSiblings(list, depth, opts);
  const out: string[] = [];
  let prevList = false;
  rendered.forEach((lines, i) => {
    if (!lines.length) return;
    const isList = LIST_TYPES.has(list[i]!.type);
    if (out.length && !(isList && prevList)) out.push('');
    out.push(...lines);
    prevList = isList;
  });
  return out;
}

/**
 * Render a list of siblings, numbering consecutive numbered items.
 *
 * @remarks
 * Numbering is a property of a block's position among its siblings, not of the
 * block, so it can only be decided here. Emitting `1.` for every item round
 * trips (CommonMark renumbers) but it is unreadable in the file — and "readable
 * without the tool" is the whole point of the markdown projection.
 */
function renderSiblings(list: BlockJSON[], depth: number, opts: MarkdownOptions): string[][] {
  let n = 0;
  return list.map((b) => {
    n = b.type === 'numbered_list_item' ? n + 1 : 0;
    return renderBlock(b, depth, opts, n);
  });
}

/** Re-indent the continuation lines a hard break produced. */
function indented(pad: string, text: string): string {
  return pad + text.split('\n').join(`\n${pad}`);
}

function renderBlock(b: BlockJSON, depth: number, opts: MarkdownOptions = {}, ordinal = 1): string[] {
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
  /*
   * A block's own line and its children need the same separation rule as two
   * siblings do: an indented *list* child reads as nesting, but an indented
   * *paragraph* child written tight against the parent reads as a lazy
   * continuation of the parent's text, and is swallowed on the next read.
   */
  const kids = () => {
    const lines = renderSiblingLines(b.children ?? [], depth + 1, opts);
    if (!lines.length || LIST_TYPES.has(b.children![0]!.type)) return lines;
    return ['', ...lines];
  };
  // quote/callout children are rendered un-indented then '> '-prefixed
  /*
   * Paragraphs inside a quote need a blank `>` line between them, or reading
   * the file back folds them into one — consecutive lines inside a blockquote
   * are one paragraph, exactly as they are outside it.
   *
   * @param afterText - True when the quote's own inline text precedes the
   * children, so the first child needs a separator too. A callout's `[!type]`
   * line is a title rather than a paragraph, so its body follows directly.
   */
  const quotedKids = (afterText: boolean) => {
    const lines = renderSiblingLines(b.children ?? [], 0, opts);
    return (afterText && lines.length ? ['', ...lines] : lines).map((l) => (l ? pad + '> ' + l : pad + '>'));
  };

  switch (b.type) {
    case 'paragraph':
      return [indented(pad, text), ...kids()];
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(p['level'] ?? 1)));
      return [pad + '#'.repeat(level) + ' ' + text, ...kids()];
    }
    case 'bulleted_list_item':
      return [indented(pad, '- ' + text), ...kids()];
    case 'numbered_list_item':
      return [indented(pad, `${ordinal}. ` + text), ...kids()];
    case 'to_do':
      return [indented(pad, (p['checked'] === true ? '- [x] ' : '- [ ] ') + text), ...kids()];
    case 'toggle':
      // documented loss: toggle-ness is lost — serialized as a plain list item with indented children
      return [indented(pad, '- ' + text), ...kids()];
    case 'quote':
      return [pad + '> ' + text, ...quotedKids(true)];
    case 'callout': {
      // Obsidian callout convention: the variant IS the callout type, so
      // presets round-trip as `> [!warning]` instead of collapsing to note
      const variant = typeof p['variant'] === 'string' && p['variant'] ? p['variant'] : 'note';
      const icon = typeof p['icon'] === 'string' && p['icon'] ? p['icon'] + ' ' : '';
      return [pad + `> [!${variant}] ` + icon + text, ...quotedKids(false)];
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
    case 'sub_page':
      // documented loss (D7): both become a wikilink, so a re-import cannot
      // tell "the page lives here" from "the page is mentioned here". In a
      // vault the hierarchy is the folder layout, which is phase 4b's job.
      return [pad + wikilink(String(p['title'] || 'page'))];
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

/**
 * Leading indentation, measured in **columns** — a tab is four.
 *
 * @remarks
 * Columns rather than a fixed four-space ladder, which is what this counted
 * before. CommonMark nests a list item under whatever column its parent's
 * content starts at, so `- a` followed by `  - b` is a child list; the ladder
 * saw two spaces, rounded to zero levels, and made them siblings. Two-space
 * nesting is what most editors emit, so that was most real markdown.
 */
function indentColumns(line: string): number {
  let cols = 0;
  for (const ch of line) {
    if (ch === '\t') cols += 4;
    else if (ch === ' ') cols++;
    else break;
  }
  return cols;
}

/** Remove up to `cols` columns of leading indentation. */
function stripColumns(line: string, cols: number): string {
  let i = 0;
  let taken = 0;
  while (i < line.length && taken < cols) {
    if (line[i] === '\t') taken += 4;
    else if (line[i] === ' ') taken++;
    else break;
    i++;
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


/**
 * Every line pattern that begins a block other than a paragraph.
 *
 * @remarks
 * Paragraph accumulation has to stop when the next line is something else,
 * which means this list must stay in step with the checks in `parseLevel`.
 * The guard against drift is a test that feeds a paragraph followed by each
 * construct in turn and asserts two blocks come back — adding a construct
 * without adding it here fails there.
 */
const CONSTRUCT_STARTS: RegExp[] = [
  /^```/, // fenced code
  /^-{3,}\s*$/, // divider
  /^!\[.*?\]\(.*?\)\s*$/, // lone image
  /^\[\[.+?\]\]\s*$/, // lone wikilink
  /^#{1,6}\s+/, // heading
  /^>\s?/, // quote or callout
  /^[-*] \[[ xX]\]\s?/, // to-do
  /^[-*]\s+/, // bulleted item
  /^\d+\.\s+/, // numbered item
];

function startsConstruct(
  line: string,
  lines: string[],
  pos: number,
  level: number,
  rules: Array<{ type: string; rule: MarkdownRule }>,
): boolean {
  if (rules.some(({ rule }) => rule.match.test(line))) return true;
  if (CONSTRUCT_STARTS.some((re) => re.test(line))) return true;
  // a pipe row is only a table when the next line is the delimiter
  return line.includes('|') && pos + 1 < lines.length && isDelimiterRow(stripColumns(lines[pos + 1]!, level));
}

/**
 * Consecutive non-blank lines that form ONE inline text, per CommonMark.
 *
 * @remarks
 * Shared by paragraphs and by list items, because they wrap identically and
 * writing it twice is how they drift — which is exactly what had happened: the
 * paragraph branch folded its continuation lines and the list branch did not,
 * so every wrapped list item shed its tail into a stray paragraph.
 *
 * Two kinds of line ending, and the difference is the whole subtlety:
 *   - a *soft* break (a bare newline) is not content. CommonMark renders it as
 *     a space, so source wrapping is normalised away. That is a documented,
 *     deliberate loss: how a file happens to be wrapped is presentation of the
 *     source, not of the document.
 *   - a *hard* break (a trailing backslash, or two trailing spaces) is
 *     content, and becomes the `\n` our model uses for Shift+Enter.
 *
 * A line that starts another construct ends the run, so the outer loop sees
 * it. Leading whitespace on a continuation line is never content — indented
 * code blocks are not a construct we support, only fenced ones.
 *
 * @param seed - **Source** text already taken from the opening line, when the
 * caller consumed it to recognise the block (a list marker, say). Source, not
 * parsed runs: inline syntax has to be read once, over the whole joined text,
 * or the first line's marks are dropped on the floor.
 */
function takeInlineText(
  lines: string[],
  pos: number,
  level: number,
  rules: Array<{ type: string; rule: MarkdownRule }>,
  seed?: string,
): [string, number] {
  const parts: string[] = [];
  const hard: boolean[] = [];
  if (seed !== undefined) {
    parts.push(seed.replace(/(\\|\s+)$/, ''));
    hard.push(/(\\|\s{2,})$/.test(seed));
  }
  while (pos < lines.length) {
    const raw = lines[pos]!;
    if (raw.trim() === '') break;
    const line = stripColumns(raw, level).trimStart();
    if (parts.length && startsConstruct(line, lines, pos, level, rules)) break;
    hard.push(/(\\|\s{2,})$/.test(raw));
    parts.push(line.replace(/(\\|\s+)$/, ''));
    pos++;
  }
  const text = parts.reduce((acc, line, i) => (i === 0 ? line : acc + (hard[i - 1] ? '\n' : ' ') + line), '');
  return [text, pos];
}

function parseLevel(
  lines: string[],
  pos: number,
  /** Column this level's content starts at; deeper lines are its children. */
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
    const ind = indentColumns(raw);
    if (ind < level) break;
    /*
     * Leading whitespace never survives into content: CommonMark lets a block
     * marker sit under a few spaces of indentation, and keeping them meant a
     * line like `  - item` matched no construct at all and became a paragraph
     * whose text literally began with "- ". Indented code blocks are not a
     * construct here — only fenced ones — so nothing is lost by trimming.
     */
    const content = raw.trimStart();
    let m: RegExpExecArray | null;

    // contributed rules first: a plugin owns its own syntax
    let claimed = false;
    for (const { rule } of rules) {
      if (!rule.match.test(content)) continue;
      const parsed = rule.parse(lines.map((l) => stripColumns(l, level)), pos);
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
      while (pos < lines.length && !/^```\s*$/.test(stripColumns(lines[pos]!, level))) {
        body.push(stripColumns(lines[pos]!, level));
        pos++;
      }
      if (pos < lines.length) pos++; // closing fence
      const lang = m[1]!.trim();
      const code = body.join('\n');
      out.push(mk('code', lang ? { language: lang } : {}, code ? [{ text: code }] : undefined));
      continue;
    }

    // GFM table: a pipe row is only a table if the next line is the delimiter
    if (content.includes('|') && pos + 1 < lines.length && isDelimiterRow(stripColumns(lines[pos + 1]!, level))) {
      const rows = [splitRow(content)];
      pos += 2;
      while (pos < lines.length) {
        const next = stripColumns(lines[pos]!, level);
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
        if (r.trim() === '' || indentColumns(r) !== level) break;
        const qm = /^>\s?(.*)$/.exec(stripColumns(r, level));
        if (!qm) break;
        quoteLines.push(qm[1]!);
        pos++;
      }
      /*
       * A quote's body is markdown in its own right — wrapped prose folds, a
       * blank `>` line starts a new paragraph, and a list inside a quote is a
       * list. Mapping one line to one child paragraph, which this did, turned
       * every wrapped quote into a stack of sub-paragraphs.
       */
      const cm = /^\[!(\w+)\][-+]?\s?(.*)$/.exec(quoteLines[0]!);
      /*
       * A callout's `[!type]` line is its **title**, so it is never folded
       * into the body — that is the Obsidian convention and the difference
       * from a plain quote, whose first line is just the first line of prose.
       */
      const [body] = parseLevel(cm ? quoteLines.slice(1) : quoteLines, 0, 0, opts);
      const lead = cm ? undefined : body[0]?.type === 'paragraph' && !body[0].children ? body.shift() : undefined;
      const children = body;
      const leadText = cm ? markdownToRuns(cm[2]!) : (lead?.text ?? []);
      if (cm) {
        // 'note' is the default rendering, so it is never stored — that keeps
        // documents lean and makes the markdown round-trip byte-stable
        const variant = cm[1]!.toLowerCase();
        out.push(mk('callout', variant === 'note' ? {} : { variant }, leadText, children));
      }
      else out.push(mk('quote', {}, leadText, children));
      continue;
    }

    // list items: to_do, bullet, numbered — all may have indented children
    let item: BlockJSON | null = null;
    let seed = '';
    if ((m = /^[-*] \[([ xX])\]\s?(.*)$/.exec(content))) {
      item = mk('to_do', { checked: m[1]!.toLowerCase() === 'x' });
      seed = m[2]!;
    } else if ((m = /^[-*]\s+(.*)$/.exec(content))) {
      item = mk('bulleted_list_item', {});
      seed = m[1]!;
    } else if ((m = /^\d+\.\s+(.*)$/.exec(content))) {
      item = mk('numbered_list_item', {});
      seed = m[1]!;
    }
    if (item) {
      /*
       * A list item's text continues onto the following lines exactly as a
       * paragraph's does — CommonMark calls the indented form a continuation
       * line and the unindented form a lazy one, and both belong to the item.
       * Without this each wrapped line became its own paragraph *between* the
       * items, which is also why numbering restarted at 1: `listNumber` in the
       * DOM package counts consecutive siblings, and those paragraphs were
       * sitting between them.
       */
      const [itemText, afterText] = takeInlineText(lines, pos + 1, level, rules, seed);
      if (itemText) item.text = markdownToRuns(itemText);
      pos = afterText;
      let j = pos;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      const childColumn = j < lines.length ? indentColumns(lines[j]!) : level;
      if (childColumn > level) {
        const [children, next] = parseLevel(lines, j, childColumn, opts);
        if (children.length) item.children = children;
        pos = next;
      }
      out.push(item);
      continue;
    }

    const [text, nextPos] = takeInlineText(lines, pos, level, rules);
    pos = nextPos;
    out.push(mk('paragraph', {}, markdownToRuns(text)));
  }
  return [out, pos];
}
