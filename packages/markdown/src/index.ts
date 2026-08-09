/**
 * The human-readable projection: markdown in both directions, plus CSV
 * and Obsidian-shaped view files for collections. Depends on core only.
 *
 * @module @nbe/markdown
 */

import type { Block, BlockJSON, BlockSpec, Mark, MarkdownRule, PluginRegistry, Run } from '@nbe/core';
import { baseSchema, uuidv7 } from '@nbe/core';

// ---------------------------------------------------------------------------
// Inline: runs → markdown
// ---------------------------------------------------------------------------

/**
 * Escape markdown control chars in plain text so it survives a round-trip.
 *
 * @remarks
 * Brackets are escaped only where they would parse *back* as a link — `[[wiki]]`
 * or `[text](url)`. Escaping every one of them filled ordinary prose with
 * backslashes for no gain, and a Markdown checklist typed into a numbered item
 * (`1. [ ] fait`, which is a numbered item and not a to-do) came back out as
 * `1. \\[ \\] fait`. The parser makes a link out of those two shapes and
 * nothing else, so those two shapes are what needs protecting.
 */
function escapeMd(s: string): string {
  return s
    .replace(/[\\`*_~]/g, (c) => '\\' + c)
    .replace(/\[(?=\[|[^\]\n]*\]\()/g, '\\[');
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
  // `==` is Obsidian's highlight, and the nearest thing Markdown has to the
  // background mark. The palette colour is lost — Markdown has one highlight —
  // which is still strictly more than the nothing that was written before.
  { type: 'background', open: '==', close: '==' },
  // no Markdown equivalent, so the HTML both Obsidian and every renderer
  // already understand. `INLINE_TAGS` reads them back; without that half,
  // underline was written and never read, and came back as literal `<u>` text.
  { type: 'underline', open: '<u>', close: '</u>' },
  { type: 'superscript', open: '<sup>', close: '</sup>' },
  { type: 'subscript', open: '<sub>', close: '</sub>' },
];

/** The inline HTML `WRAPPERS` emits, read back as marks. */
const INLINE_TAGS: Array<{ tag: string; mark: Mark }> = [
  { tag: 'u', mark: { type: 'underline' } },
  { tag: 'sup', mark: { type: 'superscript' } },
  { tag: 'sub', mark: { type: 'subscript' } },
  // what a Markdown file written elsewhere uses for `==`
  { tag: 'mark', mark: { type: 'background', attrs: { color: 'yellow' } } },
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
  if (has('mention')) {
    // a parsed wikilink carries its original target; emitting it verbatim is
    // what keeps `[[target|alias]]` from corrupting on a save
    const target = String(marks.find((m) => m.type === 'mention')?.attrs?.['target'] ?? '');
    if (target) return target === run.text ? `[[${target}]]` : `[[${target}|${run.text}]]`;
    return wikilink(run.text);
  }

  let s: string;
  if (has('code')) {
    /*
     * CommonMark's rule, because a user types what they type: fence with more
     * backticks than the content contains, and pad with a space when the
     * content starts or ends with one — otherwise the pad is what closes the
     * span. The parser strips a single symmetric pad back off.
     *
     * This replaces a `ponytail:` note that told callers to avoid backticks in
     * code, which is not advice a person writing about Markdown can follow.
     */
    const longest = Math.max(0, ...[...run.text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = '`'.repeat(longest + 1);
    const pad = run.text.startsWith('`') || run.text.endsWith('`') ? ' ' : '';
    s = fence + pad + run.text + pad + fence;
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

const DELIMS: [string, Mark[]][] = [
  ['***', [{ type: 'bold' }, { type: 'italic' }]],
  ['**', [{ type: 'bold' }]],
  ['~~', [{ type: 'strike' }]],
  // Obsidian's highlight. The palette has ten backgrounds and Markdown has
  // one, so a file says "highlighted" and the editor picks the highlighter.
  ['==', [{ type: 'background', attrs: { color: 'yellow' } }]],
  ['*', [{ type: 'italic' }]],
  ['_', [{ type: 'italic' }]],
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
      // a run of n backticks closes on the next run of exactly n
      const open = /^`+/.exec(text.slice(i))![0];
      const closeAt = text.indexOf(open, i + open.length);
      const runsOn = closeAt >= 0 && text[closeAt + open.length] === '`';
      if (closeAt > i && !runsOn) {
        let content = text.slice(i + open.length, closeAt);
        /*
         * Undo the pad, but only where the serializer would have added one:
         * when the content beneath it starts or ends with a backtick. CommonMark
         * strips a symmetric pad unconditionally, which is right for rendering
         * and wrong here — `` ` x ` `` would lose the spaces a person typed, and
         * this parser feeds an editor that has to give them back.
         */
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ')) {
          const inner = content.slice(1, -1);
          if (inner.startsWith('`') || inner.endsWith('`')) content = inner;
        }
        if (content) {
          flush();
          runs.push({ text: content, marks: [...marks.map((m) => ({ ...m })), { type: 'code' }] });
          i = closeAt + open.length;
          continue;
        }
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
        // `[[target|display]]` — the display half is what a mention shows; the
        // target half is kept in the mark so navigation and re-export resolve
        // the note the author actually pointed at, alias intact
        const raw = wm[1]!;
        const pipe = raw.indexOf('|');
        const target = pipe === -1 ? raw : raw.slice(0, pipe);
        runs.push({
          text: raw.slice(pipe + 1),
          marks: [...marks.map((m) => ({ ...m })), { type: 'mention', attrs: { target } }],
        });
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

    /*
     * The inline HTML the serializer emits for the marks Markdown cannot
     * spell. Only these tags, only when closed: everything else stays the
     * literal text someone typed, because a note is prose and `a < b` is not
     * an open tag.
     */
    if (ch === '<') {
      const tag = INLINE_TAGS.find((t) => text.startsWith(`<${t.tag}>`, i));
      if (tag) {
        const closeTag = `</${tag.tag}>`;
        const closeAt = text.indexOf(closeTag, i + tag.tag.length + 2);
        if (closeAt > 0) {
          flush();
          runs.push(
            ...parseInline(text.slice(i + tag.tag.length + 2, closeAt), [...marks, { ...tag.mark }]),
          );
          i = closeAt + closeTag.length;
          continue;
        }
      }
    }

    // emphasis delimiters; unmatched markers stay literal
    for (const [d, types] of DELIMS) {
      if (text.startsWith(d, i)) {
        let close = text.indexOf(d, i + d.length);
        // when the closer sits inside a longer run (e.g. `**a *b***`), take its rightmost end
        while (close > 0 && text[close + d.length] === d[0]) close++;
        if (close > i + d.length) {
          flush();
          runs.push(...parseInline(text.slice(i + d.length, close), [...marks, ...types.map((m) => ({ ...m }))]));
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
  /**
   * Write the `<!-- nbe:type {…} -->` trailers that carry what a line cannot
   * spell (see {@link @nbe/core!BlockSpec.spelledProps}).
   *
   * @remarks
   * On by default, because the usual destination is a file this editor will
   * read back. Turn it off for text going somewhere else — the plain-text
   * clipboard flavour, a preview — where an invisible-in-rendering comment is
   * still visible in the paste, and where fidelity is another flavour's job.
   *
   * @defaultValue true
   */
  markers?: boolean;
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

/**
 * One block, as the lines it occupies — plus the trailer its spec asks for.
 *
 * @remarks
 * The trailer is added here rather than in each branch, so it reaches the
 * plugin projections too: a plugin declares `spelledProps` and its own props
 * start surviving the file, with no change to its `toMarkdown`.
 */
function renderBlock(b: BlockJSON, depth: number, opts: MarkdownOptions = {}, ordinal = 1): string[] {
  return withTrailer(b, renderLines(b, depth, opts, ordinal), opts);
}

function renderLines(b: BlockJSON, depth: number, opts: MarkdownOptions, ordinal: number): string[] {
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
      // a bullet for every other tool; the trailer its spec asks for is what
      // makes it a toggle again here, children and collapsed state included
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
    case 'divider':
      return [pad + '---'];
    case 'image':
      // the caption, the alignment and the width ride in the trailer: an image
      // that came back left-aligned and full-width every time it was saved was
      // losing the only thing the block stores beyond its source
      return [pad + `![${text}](${String(p['src'] ?? '')})`];
    /*
     * The link is what other Markdown tools render, and the `asset:` ref in it
     * is resolved by the host, so the bytes are reachable from the vault.
     *
     * The ref is deliberately left out of the marker: one copy in the file
     * means the garbage collector's scan and a hand edit cannot disagree.
     *
     * The trailing marker is what makes it a *file* again on the way back. A
     * bare link cannot be: any rule broad enough to claim one would claim
     * every paragraph that happens to be a link — which is why this used to be
     * a documented loss (D7), and why the loss was worse than documented. The
     * mime type and the size are what the block renders (a PDF gets a viewer,
     * a download gets its weight), so a re-import gave a paragraph where a
     * file card had been. Always written, even with nothing to carry: the
     * marker *is* the type.
     */
    case 'file':
      return [pad + `[${String(p['name'] ?? 'fichier')}](${String(p['src'] ?? '')})`];
    case 'link_to_page':
    case 'sub_page': {
      // documented loss (D7): both become a wikilink, so a re-import cannot
      // tell "the page lives here" from "the page is mentioned here". In a
      // vault the hierarchy is the folder layout, which is phase 4b's job.
      const title = String(p['title'] || 'page');
      const target = String(p['target'] ?? '');
      if (target) return [pad + (target === title ? `[[${target}]]` : `[[${target}|${title}]]`)];
      return [pad + wikilink(title)];
    }
    case 'column_list':
      // documented loss: column layout is lost — columns' contents flattened sequentially
      return (b.children ?? []).flatMap((col) => (col.children ?? []).flatMap((c) => renderBlock(c, depth)));
    default:
      // unknown type: marker comment so nothing silently disappears, then children
      return [pad + unknownMarker(b), ...(b.children ?? []).flatMap((c) => renderBlock(c, depth))];
  }
}

/**
 * The line an unregistered block type is written as: `<!-- nbe:type {…} -->`.
 *
 * @remarks
 * The type alone was not enough. A block whose plugin is not loaded — the
 * table of contents in a host that only registered the core blocks, a
 * third-party block in the CLI — was written as a bare marker, so every save
 * quietly stripped its props and its text. Markdown is the storage format
 * here, which makes that data loss on a round-trip through a smaller plugin
 * set, not a rendering detail.
 *
 * The payload is JSON, and `--` inside it is escaped as `--` so no
 * value can close the comment early. `--` never occurs outside a JSON string,
 * so escaping it blind is safe and `JSON.parse` gives the original back.
 */
export function unknownMarker(b: BlockJSON): string {
  const payload: Record<string, unknown> = {};
  if (b.props && Object.keys(b.props).length) payload['props'] = b.props;
  if (b.text?.length) payload['text'] = b.text;
  return marker(b.type, payload);
}

/** `<!-- nbe:type {…} -->`, with nothing in the payload able to close it early. */
function marker(type: string, payload: Record<string, unknown>): string {
  const data = Object.keys(payload).length ? ' ' + JSON.stringify(payload).replace(/--/g, '\\u002d\\u002d') : '';
  return `<!-- nbe:${type}${data} -->`;
}

/**
 * The spec a block type declares, whether it is built in or brought by a
 * plugin — the two places a `spelledProps` declaration can come from.
 */
const BASE = baseSchema();

function specOf(type: string, opts: MarkdownOptions): BlockSpec | undefined {
  return opts.plugins?.get(type)?.schema ?? (BASE.has(type) ? BASE.get(type) : undefined);
}

/**
 * What a block's own line cannot say, as the marker that follows it.
 *
 * @remarks
 * Driven entirely by {@link @nbe/core!BlockSpec.spelledProps}: no list of
 * types lives here, so a block that grows a prop — or a plugin that ships a
 * new one — is carried without this package learning about it. A type that
 * declares nothing keeps today's behaviour and writes no trailer.
 */
function trailer(b: BlockJSON, opts: MarkdownOptions): string {
  const spec = specOf(b.type, opts);
  if (opts.markers === false || !spec?.spelledProps) return '';
  const rest = Object.fromEntries(
    Object.entries(b.props ?? {}).filter(([k, v]) => !spec.spelledProps!.includes(k) && v !== undefined),
  );
  const payload = Object.keys(rest).length ? { props: rest } : {};
  // the marker is written for nothing only when it is the one thing saying
  // which block this line was
  if (!Object.keys(payload).length && !spec.markdownAmbiguous) return '';
  return ` ${marker(b.type, payload)}`;
}

/** Append a block's trailer to its own line — the first of the lines it wrote. */
function withTrailer(b: BlockJSON, lines: string[], opts: MarkdownOptions): string[] {
  const suffix = trailer(b, opts);
  if (!suffix || !lines.length) return lines;
  return [lines[0] + suffix, ...lines.slice(1)];
}

/** The props a trailing marker carries, or none if it is absent or corrupt. */
function trailerProps(payload: string | undefined): Record<string, unknown> {
  if (!payload?.startsWith('{')) return {};
  try {
    return (JSON.parse(payload) as { props?: Record<string, unknown> }).props ?? {};
  } catch {
    return {};
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

/**
 * The marker a line carries after the construct it is: `<!-- nbe:type {…} -->`.
 *
 * @remarks
 * It says what the line could not — the props the syntax has no room for, and
 * for an ambiguous line (a toggle written as a bullet, a file written as a
 * link) the type itself. Stripped before the line is matched, so every
 * construct reads exactly as it did before markers existed.
 */
const TRAILER = /\s*<!--\s*nbe:([A-Za-z0-9_-]+)\s*(.*?)\s*-->\s*$/;

const CONSTRUCT_STARTS: RegExp[] = [
  /^<!--\s*nbe:/, // an unloaded plugin's block
  /^-{3,}\s*$/, // divider
  /^!\[.*?\]\(.*?\)\s*$/, // lone image
  /^\[\[.+?\]\]\s*$/, // lone wikilink
  /^#{1,6}\s+/, // heading
  /^>\s?/, // quote or callout
  /^[-*+] \[[ xX]\]\s?/, // to-do
  /^[-*+]\s+/, // bulleted item
  /^\d+\.\s+/, // numbered item
];

function startsConstruct(
  line: string,
  lines: string[],
  pos: number,
  level: number,
  rules: Array<{ type: string; rule: MarkdownRule }>,
): boolean {
  /*
   * `match` is the cheap prefilter; `parse` is the authority. A construct can
   * need the *next* line to know it is one — a GFM table is a pipe row only
   * when the delimiter follows — and a single-line regex cannot see that. The
   * table used to be special-cased here by name; asking the rule instead is
   * what let it leave for its own package.
   */
  if (rules.some(({ rule }) => rule.match.test(line) && rule.parse(lines.map((l) => stripColumns(l, level)), pos)))
    return true;
  // a marker makes the line a block of its own — including a link, which is
  // prose without one. The constructs are matched on the line without it.
  if (TRAILER.test(line)) return true;
  return CONSTRUCT_STARTS.some((re) => re.test(line.replace(TRAILER, '')));
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
    // a marker is never content: it belongs to the block, not to its text
    parts.push(line.replace(TRAILER, '').replace(/(\\|\s+)$/, ''));
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
    const full = raw.trimStart();
    /*
     * The trailer is read once, here, and taken off the line before anything
     * tries to match it: a construct must parse the same whether or not it
     * carries one. Every block this iteration produces then goes through
     * `push`, which is where the marker's type and props are put back on —
     * so no branch below has to know markers exist.
     */
    const trail = TRAILER.exec(full);
    const content = trail ? full.slice(0, trail.index) : full;
    const push = (b: BlockJSON): void => {
      if (!trail) {
        out.push(b);
        return;
      }
      // the line wins over the marker: a name edited by hand in the file is the
      // one the reader meant, and the writer never puts a spelled prop in both
      const props = { ...trailerProps(trail[2]), ...b.props };
      out.push({
        ...b,
        type: trail[1] ?? b.type,
        ...(Object.keys(props).length ? { props } : {}),
      });
    };
    let m: RegExpExecArray | null;

    // contributed rules first: a plugin owns its own syntax
    let claimed = false;
    for (const { rule } of rules) {
      /*
       * Against the line *with* its trailer as well as without it. Stripping
       * the trailer is right for every construct — a to-do parses the same
       * whether or not it carries one — and it made the note below
       * ("a plugin that wants to own its own marker syntax still wins")
       * unreachable: a line that is nothing but a marker leaves `content`
       * empty, so no contributed rule could ever match it and the generic
       * marker path claimed it first. A block whose Markdown *is* a marker —
       * one that opens a fence, say — could not be written as a plugin.
       */
      if (!rule.match.test(content) && !rule.match.test(full)) continue;
      const parsed = rule.parse(lines.map((l) => stripColumns(l, level)), pos);
      if (!parsed) continue;
      const block = parsed.block as unknown as BlockJSON;
      push({ ...block, id: block.id || uuidv7() });
      pos += parsed.consumed;
      claimed = true;
      break;
    }
    if (claimed) continue;

    /*
     * A marker with no construct in front of it: a block whose plugin was not
     * registered when the file was written. Read back as the type it names,
     * with whatever props and text it carried — the plugin may well be loaded
     * *now*, in which case the block simply works again, and if it is not,
     * `@nbe/dom` renders it as an unrecognised block rather than dropping it.
     *
     * After the contributed rules, so a plugin that wants to own its own
     * marker syntax still wins.
     */
    if (trail && !content.trim()) {
      let payload: { props?: Record<string, unknown>; text?: Run[] } = {};
      // a corrupted payload costs the props, never the block
      if (trail[2]?.startsWith('{')) try { payload = JSON.parse(trail[2]) as typeof payload; } catch { payload = {}; }
      out.push(mk(trail[1]!, payload.props ?? {}, payload.text));
      pos++;
      continue;
    }

    // divider
    if (/^-{3,}\s*$/.test(content)) {
      push(mk('divider', {}));
      pos++;
      continue;
    }

    // image alone on a line
    if ((m = /^!\[(.*?)\]\((.*?)\)\s*$/.exec(content))) {
      push(mk('image', { src: m[2]! }, m[1] ? markdownToRuns(m[1]) : undefined));
      pos++;
      continue;
    }

    /*
     * A lone link is prose — unless the marker says the line is a file card.
     * That is the whole of what makes a file readable again, and why the type
     * declares itself `markdownAmbiguous`: nothing in `[nom](cible)` says
     * "block".
     */
    if (trail?.[1] === 'file' && (m = /^\[(.*?)\]\((.*?)\)\s*$/.exec(content))) {
      push(mk('file', { src: m[2]!, name: m[1]! }));
      pos++;
      continue;
    }

    // wikilink alone on a line
    if ((m = /^\[\[(.+?)\]\]\s*$/.exec(content))) {
      const target = m[1]!;
      const pipe = target.indexOf('|');
      push(
        mk('link_to_page', {
          title: target.slice(pipe + 1),
          target: pipe === -1 ? target : target.slice(0, pipe),
        }),
      );
      pos++;
      continue;
    }

    // heading
    if ((m = /^(#{1,6})\s+(.*)$/.exec(content))) {
      push(mk('heading', { level: Math.min(3, m[1]!.length) }, markdownToRuns(m[2]!)));
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
        push(mk('callout', variant === 'note' ? {} : { variant }, leadText, children));
      }
      else push(mk('quote', {}, leadText, children));
      continue;
    }

    // list items: to_do, bullet, numbered — all may have indented children
    let item: BlockJSON | null = null;
    let seed = '';
    if ((m = /^[-*+] \[([ xX])\]\s?(.*)$/.exec(content))) {
      item = mk('to_do', { checked: m[1]!.toLowerCase() === 'x' });
      seed = m[2]!;
    } else if ((m = /^[-*+]\s+(.*)$/.exec(content))) {
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
      push(item);
      continue;
    }

    const [text, nextPos] = takeInlineText(lines, pos, level, rules);
    pos = nextPos;
    push(mk('paragraph', {}, markdownToRuns(text)));
  }
  return [out, pos];
}
