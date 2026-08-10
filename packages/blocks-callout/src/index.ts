/**
 * The callout block: an aside with an icon, for a note the reader should not
 * skip. This entry carries everything that does **not** need a DOM — the
 * schema and both projections — so `@nbe/markdown` and
 * `@nbe/static-renderer` can consume it without pulling in the editor view.
 *
 * The editing behaviour lives in `@nbe/blocks-callout/dom`.
 *
 * @module @nbe/blocks-callout
 */
import type { Block, BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION, plainText } from '@nbe/core';

/** Preset variants, in the order they appear in menus. */
export const CALLOUT_PRESETS = [
  { name: 'note', label: 'Note', icon: '💡', backgroundColor: 'gray' },
  { name: 'info', label: 'Info', icon: 'ℹ️', backgroundColor: 'blue' },
  { name: 'tip', label: 'Astuce', icon: '🚀', backgroundColor: 'purple' },
  { name: 'success', label: 'Succès', icon: '✅', backgroundColor: 'green' },
  { name: 'warning', label: 'Attention', icon: '⚠️', backgroundColor: 'yellow' },
  { name: 'danger', label: 'Erreur', icon: '🛑', backgroundColor: 'red' },
  { name: 'quote', label: 'Citation', icon: '❝', backgroundColor: 'brown' },
] as const;

const CALLOUT_LINE = /^>\s?\[!(\w+)\][-+]?\s?(.*)$/;

/**
 * Markdown in both directions, using Obsidian's callout convention.
 *
 * @remarks
 * The variant *is* the callout type, so a preset round-trips as
 * `> [!warning]` instead of collapsing to a plain quote. `note` is the default
 * rendering and is therefore never written into props, which keeps documents
 * lean and the round-trip byte-stable.
 *
 * @category Projections
 */
export const calloutMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const props = block.props ?? {};
    const variant = typeof props['variant'] === 'string' && props['variant'] ? props['variant'] : 'note';
    const icon = typeof props['icon'] === 'string' && props['icon'] ? `${props['icon']} ` : '';
    const children = (block.children ?? []).flatMap((c) => ctx.child(c as unknown as Block));
    return [`${pad}> [!${variant}] ${icon}${plainText(block.text)}`, ...children.map((l) => `${pad}> ${l}`)];
  },

  fromMarkdown: [
    {
      match: CALLOUT_LINE,
      parse(lines, start) {
        const m = CALLOUT_LINE.exec(lines[start] ?? '');
        if (!m) return null;
        let consumed = 1;
        while (start + consumed < lines.length && /^>\s?/.test(lines[start + consumed] ?? '')) consumed++;
        const variant = m[1]!.toLowerCase();
        return {
          block: {
            id: '',
            type: 'callout',
            version: 1,
            props: variant === 'note' ? {} : { variant },
            text: [{ text: m[2] ?? '' }],
            children: [],
            parentId: null,
          },
          consumed,
        };
      },
    },
  ],
};

/**
 * The callout, minus its editing behaviour.
 *
 * @remarks
 * Import from `@nbe/blocks-callout/dom` instead when mounting an editor; that
 * entry re-exports this one with its `view` filled in.
 *
 * @category Plugins
 */
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const calloutPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'callout',
    version: 1,
    inline: true,
    defaultProps: { variant: 'note', icon: '💡', backgroundColor: 'gray' },
    placeholder: 'Une note à mettre en avant…',
  },
  markdown: calloutMarkdown,
  html(block) {
    // an id is an attribute value, so it is escaped like any other — a block id
    // is a uuid today and that is not a reason for the projection to assume so
    const icon = String((block.props ?? {})['icon'] ?? '💡');
    /*
     * The block id, like every built-in block emits — it is what an anchor
     * points at, and a plugin returning its own markup was quietly the one
     * kind of block a link into an export could not reach.
     */
    return `<aside id="${escapeHtml(block.id)}" class="nbe-t-callout"><span class="nbe-callout-icon">${icon}</span><div>${plainText(block.text)}</div></aside>`;
  },
};
