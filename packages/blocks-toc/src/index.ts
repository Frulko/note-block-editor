/**
 * The table of contents: a block whose content **is** the document.
 *
 * @remarks
 * Every other block owns its text. This one owns none — it reads the page's
 * headings and renders links to them, so it changes when something *else*
 * changes. That is the whole of what makes it interesting as a plugin, and the
 * reason {@link @nbe/core!ProjectionContext.page} exists: a projection that
 * renders one block in isolation cannot build a list of the others.
 *
 * The anchors are block ids. A slug of the heading text would read better in a
 * URL, but a block id is what the model already guarantees to be stable and
 * unique — a slug collides on two headings called "Notes" and moves when a
 * heading is reworded, which silently breaks every link that pointed at it.
 * ponytail: add a `slug` option if the exported URLs matter more than that.
 *
 * The editing behaviour lives in `@nbe/blocks-toc/dom`.
 *
 * @module @nbe/blocks-toc
 */
import type { Block, BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION, plainText } from '@nbe/core';

/** One line of a table of contents. */
export interface TocEntry {
  /** The heading block's id, which is also its anchor in an HTML export. */
  id: string;
  /** 1–3, as `heading` stores it. */
  level: number;
  text: string;
}

/** The marker a table of contents is written as in Markdown. */
export const TOC_MARKER = '[TOC]';

const TOC_LINE = /^\[TOC(?::([a-z]+))?\]\s*$/i;

/**
 * The looks a contents block can take, in the order they appear in menus.
 *
 * @remarks
 * Presentation only — every preset lists the same headings and links to the
 * same anchors, so switching one never changes what the block *means*. That is
 * why the style is a prop and not a block type.
 *
 * @category Plugins
 */
export const TOC_STYLES = [
  { name: 'underline', label: 'Souligné', icon: '﹍' },
  { name: 'plain', label: 'Simple', icon: '☰' },
  { name: 'rail', label: 'Barre latérale', icon: '▏' },
  { name: 'numbered', label: 'Numéroté', icon: '1.' },
] as const;

/** One of {@link TOC_STYLES}' names. */
export type TocStyle = (typeof TOC_STYLES)[number]['name'];

const DEFAULT_STYLE: TocStyle = 'underline';

/** The block's style, falling back to the default for anything unknown. */
export function tocStyle(props: Record<string, unknown> | undefined): TocStyle {
  const value = props?.['style'];
  return TOC_STYLES.some((s) => s.name === value) ? (value as TocStyle) : DEFAULT_STYLE;
}

/**
 * The headings of a page, in document order.
 *
 * @remarks
 * Takes the *nested* block shape the projections are handed, so it works from
 * a parsed document with no editor in the process. Empty headings are skipped:
 * a line in the contents pointing at nothing is worse than a shorter list.
 */
export function tocEntries(blocks: readonly Block[]): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.type === 'heading') {
        const text = plainText(block.text).trim();
        const level = Number(block.props?.['level'] ?? 1);
        if (text) out.push({ id: block.id, level: Math.min(3, Math.max(1, level || 1)), text });
      }
      const children = block.children as unknown as Block[] | undefined;
      if (children?.length && typeof children[0] === 'object') walk(children);
    }
  };
  walk(blocks);
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * `[TOC]` on a line of its own, which is Python-Markdown's spelling and the
 * one most static site generators already understand.
 *
 * @category Projections
 */
export const tocMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    // the default style stays a bare `[TOC]`, so the common file is the one
    // every other Markdown tool already reads
    const style = tocStyle(block.props);
    const marker = style === DEFAULT_STYLE ? TOC_MARKER : `[TOC:${style}]`;
    return [`${'    '.repeat(ctx.depth)}${marker}`];
  },
  fromMarkdown: [
    {
      match: TOC_LINE,
      parse(lines, start) {
        const m = TOC_LINE.exec(lines[start] ?? '');
        if (!m) return null;
        const style = m[1] ? tocStyle({ style: m[1].toLowerCase() }) : DEFAULT_STYLE;
        return {
          block: {
            id: '',
            type: 'table_of_contents',
            version: 1,
            props: style === DEFAULT_STYLE ? {} : { style },
            text: [],
            children: [],
            parentId: null,
          },
          consumed: 1,
        };
      },
    },
  ],
};

/**
 * The table of contents, minus its editing behaviour.
 *
 * @category Plugins
 */
export const tocPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'table_of_contents',
    version: 1,
    inline: false,
    placeholder: 'Aucun titre dans cette page',
  },
  markdown: tocMarkdown,
  html(block, ctx) {
    // no page in context means this block was rendered on its own — a clipboard
    // slice, a fragment. An empty nav is honest; inventing a list is not.
    const entries = tocEntries(ctx.page ?? []);
    const items = entries
      .map((e) => `<li class="nbe-toc-l${e.level}"><a href="#${escapeHtml(e.id)}">${escapeHtml(e.text)}</a></li>`)
      .join('');
    return `<nav id="${escapeHtml(block.id)}" class="nbe-t-table_of_contents" data-toc-style="${tocStyle(block.props)}" aria-label="Table des matières"><ul>${items}</ul></nav>`;
  },
};

/**
 * The plugin, as the array a headless host registers.
 *
 * @example
 * ```ts
 * import { tocBlocks } from '@nbe/blocks-toc'
 * const editor = new Editor({ plugins: tocBlocks })
 * ```
 *
 * @category Plugins
 */
export const tocBlocks: BlockPlugin[] = [tocPlugin];
