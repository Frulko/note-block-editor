import type { BlockJSON, Mark, Run } from '@nbe/core';
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

export function blocksToMarkdown(blocks: BlockJSON[]): string {
  const groups = blocks.map((b) => ({ lines: renderBlock(b, 0), list: LIST_TYPES.has(b.type) }));
  let out = '';
  groups.forEach((g, idx) => {
    if (g.lines.length === 0) return;
    // blank line between top-level blocks except between consecutive list items
    if (out) out += g.list && groups[idx - 1]?.list ? '\n' : '\n\n';
    out += g.lines.join('\n');
  });
  return out;
}

function renderBlock(b: BlockJSON, depth: number): string[] {
  const pad = '    '.repeat(depth);
  const p = b.props ?? {};
  const text = runsToMarkdown(b.text);
  const kids = () => (b.children ?? []).flatMap((c) => renderBlock(c, depth + 1));
  // quote/callout children are rendered un-indented then '> '-prefixed
  const quotedKids = () => (b.children ?? []).flatMap((c) => renderBlock(c, 0)).map((l) => pad + '> ' + l);

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
      // Obsidian callout convention; icon emoji prepended to the text when present
      const icon = typeof p['icon'] === 'string' && p['icon'] ? p['icon'] + ' ' : '';
      return [pad + '> [!note] ' + icon + text, ...quotedKids()];
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

export function markdownToBlocks(text: string): BlockJSON[] {
  const [blocks] = parseLevel(text.split(/\r?\n/), 0, 0);
  return blocks;
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

function parseLevel(lines: string[], pos: number, level: number): [BlockJSON[], number] {
  const out: BlockJSON[] = [];
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
      const cm = /^\[!\w+\]\s?(.*)$/.exec(quoteLines[0]!);
      if (cm) out.push(mk('callout', {}, markdownToRuns(cm[1]!), children));
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
        const [children, next] = parseLevel(lines, j, level + 1);
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
