import { markdownToBlocks, type MarkdownOptions } from '@nbe/markdown';
import { uuidv7, type BlockJSON } from '@nbe/core';

/**
 * Notion's "Enhanced Markdown" — Markdown plus XML-ish container tags.
 *
 * @remarks
 * Notion's Data APIs speak this on `GET /v1/pages/:id/markdown` and friends.
 * It extends Markdown with tags for exactly the constructs that have no
 * Markdown form: `<callout>`, `<details>/<summary>` for toggles,
 * `<columns>/<column>`, `<page>` and `<database>` references, mention tags,
 * `<empty-block/>`, and `{color="Blue"}` attributes on inline text
 * (`docs/research/storage-markdown-sqlite.md` §2d).
 *
 * That note draws the conclusion this project already acted on: even Notion
 * concluded "Markdown + typed containers" is the right interchange surface.
 * The tags map onto blocks we already have, which is why this is a translation
 * rather than a new model.
 *
 * **What is deliberately dropped**, because there is nothing to map it to:
 * `<synced_block>` (identity we do not model), `<table_of_contents>` (derived,
 * not authored), and `<database>` bodies (Notion does not encode views or
 * formulas in this format either). Each leaves its *content* behind rather
 * than deleting it, so no prose is lost to an unsupported wrapper.
 *
 * **Honest limit**, the same as the ZIP importer next door: these rules come
 * from the format's published description, and the fixtures are written from
 * it. Nothing here has been run against output from a real Notion workspace.
 *
 * @category Storage
 */

/** Notion's nine hues, as our palette names them (`dom/src/colors.ts`). */
const COLOR_NAMES = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);

/** A block-level container and the lines it holds. */
interface Region {
  tag: string;
  attrs: Record<string, string>;
  lines: string[];
}

const OPEN = /^\s*<([a-z_][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>\s*$/i;
const CLOSE = /^\s*<\/([a-z_][\w-]*)>\s*$/i;
const SELF_CLOSING = /^\s*<([a-z_][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*\/>\s*$/i;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w-]+)="([^"]*)"/g)) out[match[1]!] = match[2]!;
  return out;
}

/**
 * Split text into plain-markdown stretches and balanced tag regions.
 *
 * @remarks
 * Line-based rather than a real XML parse, because in this format the
 * containers sit on their own lines and their content is Markdown, not XML.
 * An unbalanced closing tag is ignored instead of throwing: a partial document
 * should import as far as it goes.
 */
function split(text: string): Array<string | Region> {
  const out: Array<string | Region> = [];
  const lines = text.split('\n');
  let plain: string[] = [];

  const flush = () => {
    if (plain.length) out.push(plain.join('\n'));
    plain = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = OPEN.exec(line);
    if (!open || SELF_CLOSING.test(line)) {
      plain.push(line);
      continue;
    }
    // find the matching close, counting nested tags of the same name
    const tag = open[1]!;
    let depth = 1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (OPEN.exec(lines[j]!)?.[1] === tag && !SELF_CLOSING.test(lines[j]!)) depth++;
      else if (CLOSE.exec(lines[j]!)?.[1] === tag && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      plain.push(line); // unbalanced: treat it as text rather than lose the rest
      continue;
    }
    flush();
    out.push({ tag, attrs: parseAttrs(open[2] ?? ''), lines: lines.slice(i + 1, end) });
    i = end;
  }
  flush();
  return out;
}

/** `<summary>Titre</summary>` on the first line of a `<details>` region. */
function takeSummary(lines: string[]): { summary: string; rest: string[] } {
  const at = lines.findIndex((line) => line.trim());
  const match = at >= 0 ? /^\s*<summary>(.*)<\/summary>\s*$/i.exec(lines[at]!) : null;
  if (!match) return { summary: '', rest: lines };
  return { summary: match[1]!, rest: [...lines.slice(0, at), ...lines.slice(at + 1)] };
}

const block = (type: string, props?: Record<string, unknown>, children?: BlockJSON[]): BlockJSON => ({
  id: uuidv7(),
  type,
  version: 1,
  ...(props ? { props } : {}),
  ...(children ? { children } : {}),
});

/**
 * Rewrite the inline tags and attributes Markdown cannot carry.
 *
 * @remarks
 * `<mention-page>` becomes an ordinary link, so the ZIP importer's existing
 * link resolution turns it into a mention pointing at the right page — one
 * mechanism rather than two that must agree. `{color="Blue"}` becomes nothing:
 * our colours are a closed palette of *names* (§2.2) and the ones Notion uses
 * match, but the attribute attaches to a span this line-based pass cannot
 * delimit. Dropping the colour and keeping the words is the right way round.
 */
function rewriteInline(text: string): string {
  return text
    .replace(/<mention-page\s+url="([^"]*)"\s*>(.*?)<\/mention-page>/gi, (_, url: string, label: string) =>
      `[${label || 'page'}](${url})`,
    )
    .replace(/<mention-page\s+url="([^"]*)"\s*\/>/gi, (_, url: string) => `[page](${url})`)
    .replace(/<mention-date\s+start="([^"]*)"[^>]*\/?>/gi, (_, start: string) => start)
    .replace(/<mention-user[^>]*>(.*?)<\/mention-user>/gi, '$1')
    .replace(/<mention-user[^>]*\/>/gi, '')
    .replace(/\{color="(\w+)"\}/gi, (whole, name: string) =>
      COLOR_NAMES.has(name.toLowerCase()) ? '' : whole,
    )
    .replace(/\{toggle="true"\}/gi, '')
    .replace(/<empty-block\s*\/>/gi, '')
    .replace(/<table_of_contents\s*\/>/gi, '');
}

/**
 * Parse Notion-flavoured Markdown into blocks.
 *
 * @param text - The body of one page, as the API returns it.
 */
export function enhancedToBlocks(text: string, opts: MarkdownOptions = {}): BlockJSON[] {
  const out: BlockJSON[] = [];

  for (const part of split(text)) {
    if (typeof part === 'string') {
      out.push(...markdownToBlocks(rewriteInline(part), opts));
      continue;
    }

    const children = enhancedToBlocks(part.lines.join('\n'), opts);
    switch (part.tag.toLowerCase()) {
      case 'callout': {
        /*
         * A callout carries inline text, not children — so its first paragraph
         * becomes the callout's own text and anything after it nests, which is
         * the same shape the vault importer gives a quote.
         */
        const lead = children[0]?.type === 'paragraph' ? children.shift() : undefined;
        out.push({
          ...block('callout', part.attrs['icon'] ? { icon: part.attrs['icon'] } : undefined, children.length ? children : undefined),
          ...(lead?.text ? { text: lead.text } : {}),
        });
        break;
      }
      case 'details': {
        const { summary, rest } = takeSummary(part.lines);
        const body = enhancedToBlocks(rest.join('\n'));
        const [head] = markdownToBlocks(rewriteInline(summary), opts);
        out.push({
          ...block('toggle', { collapsed: false }, body.length ? body : undefined),
          ...(head?.text ? { text: head.text } : {}),
        });
        break;
      }
      case 'columns':
        // only columns may be children of a column list (§2.3)
        out.push(block('column_list', undefined, children.filter((c) => c.type === 'column')));
        break;
      case 'column':
        out.push(block('column', {}, children));
        break;
      case 'page':
      case 'database':
        // a reference, not content: the body is a label
        out.push(
          block('link_to_page', {
            pageId: '',
            title: part.lines.join(' ').trim() || part.attrs['title'] || 'Page',
            href: part.attrs['url'] ?? '',
          }),
        );
        break;
      default:
        /*
         * synced_block, and anything Notion adds later. Unwrapping keeps the
         * prose and loses only the wrapper — the opposite of dropping a block
         * because its container was unfamiliar.
         */
        out.push(...children);
    }
  }
  return out;
}

/** True when a document uses the tags this module understands. */
export function isEnhancedMarkdown(text: string): boolean {
  return /<(callout|details|columns|column|page|database|synced_block|mention-page|empty-block)\b/i.test(text);
}
