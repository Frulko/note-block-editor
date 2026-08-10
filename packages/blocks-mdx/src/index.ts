/**
 * MDX components: kept, shown, and never evaluated.
 *
 * @remarks
 * **The decision first, because everything else follows from it: this does not
 * run anything.** MDX is Markdown with JSX in it, and evaluating JSX means a
 * component runtime, a compiler, and arbitrary code from a file someone was
 * handed — in an editor whose whole claim is that your notes are plain files
 * you can read without it. The same answer as the HTML embed, for the same
 * reason: a page you drop in runs in a sandbox that can reach nothing, and a
 * component someone wrote in an `.mdx` file is shown as what it is.
 *
 * What that buys, and it is the thing that was actually missing: **an `.mdx`
 * file opens in this editor and closes byte-for-byte unchanged.** Without it a
 * component tag is prose — `<Callout type="warning">` parses as a paragraph,
 * gets its angle brackets escaped on save, and the file stops being MDX. That
 * is the loss this block exists to prevent.
 *
 * A host that *does* want to render one registers its own block plugin for
 * that component and it stops arriving here at all — this is the fallback, not
 * the ceiling.
 *
 * @module @nbe/blocks-mdx
 */
import type { BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION } from '@nbe/core';

/**
 * A component tag starts a line with `<` and a capital letter.
 *
 * @remarks
 * The capital is JSX's own rule — a lowercase tag is an HTML element, which
 * Markdown already carries perfectly well and which this must not claim. So
 * `<div>` stays prose and `<Callout>` becomes a block, which is exactly the
 * line MDX itself draws.
 */
const OPEN = /^<([A-Z][A-Za-z0-9_.]*)([\s>/])/;

/** The tag name a block holds, for display. */
export function componentName(source: string): string {
  return OPEN.exec(source.trim())?.[1] ?? 'Composant';
}

export const mdxMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const source = String((block.props ?? {})['source'] ?? '');
    return source.split('\n').map((line) => (line ? pad + line : line));
  },
  fromMarkdown: [
    {
      match: OPEN,
      parse(lines, start) {
        const first = lines[start] ?? '';
        const m = OPEN.exec(first);
        if (!m) return null;
        const name = m[1]!;
        // self-closing, or opened and closed on the one line
        const closesHere = /\/>\s*$/.test(first) || first.includes(`</${name}>`);
        let consumed = 1;
        if (!closesHere) {
          const close = `</${name}>`;
          while (start + consumed < lines.length && !(lines[start + consumed] ?? '').includes(close)) consumed++;
          // no closing tag anywhere: this is prose after all, not a component
          if (start + consumed >= lines.length) return null;
          consumed++;
        }
        return {
          block: {
            id: '',
            type: 'mdx_component',
            version: 1,
            props: { source: lines.slice(start, start + consumed).join('\n') },
            text: [],
            children: [],
            parentId: null,
          },
          consumed,
        };
      },
    },
  ],
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const mdxPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: { type: 'mdx_component', version: 1, inline: false, defaultProps: { source: '' } },
  markdown: mdxMarkdown,
  html(block) {
    // shown, not run — the same promise the editor makes
    const source = String((block.props ?? {})['source'] ?? '');
    return `<pre id="${escapeHtml(block.id)}" class="nbe-t-mdx_component"><code>${escapeHtml(source)}</code></pre>`;
  },
};

/** @category Plugins */
export const mdxBlocks: BlockPlugin[] = [mdxPlugin];
