/**
 * The code block: one type, a tokenizer, and both projections. No DOM.
 *
 * The editing behaviour — the language picker, the copy button, and the
 * highlighting itself — lives in `@nbe/blocks-code/dom`. This entry is what
 * `@nbe/markdown`, `@nbe/static-renderer` and a headless export consume.
 *
 * @module @nbe/blocks-code
 */
import type { Block, BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION, plainText } from '@nbe/core';
import { isLoaded, tokenize } from './highlight';

export * from './highlight';
export { CODE_THEMES, type CodeTheme } from './styles';

const FENCE = /^(?:```|~~~)\s*([\w+-]*)\s*$/;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Fenced code blocks, both directions.
 *
 * @remarks
 * The fence's info string *is* `props.language`, which is what makes the
 * picker and the markdown agree: a block tagged `python` round-trips as
 * ` ```python `, and a language we do not ship still round-trips as the word
 * the file had.
 *
 * @category Projections
 */
export const codeMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const language = String(block.props?.['language'] ?? 'plain');
    const fence = pad + '```' + (language && language !== 'plain' ? language : '');
    return [fence, ...plainText(block.text).split('\n').map((line) => pad + line), pad + '```'];
  },

  fromMarkdown: [
    {
      match: /^(?:```|~~~)/,
      parse(lines, start) {
        const open = FENCE.exec((lines[start] ?? '').trim());
        if (!open) return null;
        const body: string[] = [];
        let consumed = 1;
        while (start + consumed < lines.length && !/^(?:```|~~~)\s*$/.test((lines[start + consumed] ?? '').trim())) {
          body.push(lines[start + consumed]!);
          consumed++;
        }
        // an unterminated fence still ends the block: the alternative is
        // swallowing the rest of the document into a code block
        if (start + consumed < lines.length) consumed++;
        const language = open[1] || 'plain';
        const text = body.join('\n');
        return {
          block: {
            id: '',
            type: 'code',
            version: 1,
            props: language === 'plain' ? {} : { language },
            text: text ? [{ text }] : [],
            children: [],
            parentId: null,
          } as unknown as Block,
          consumed,
        };
      },
    },
  ],
};

/**
 * `<pre><code class="language-x">` with real `<span>`s.
 *
 * @remarks
 * The one place where spans are the right answer: an exported page has no
 * caret to protect, so the same tokens the editor paints as ranges become
 * elements here. When the grammar is not loaded the text still ships, tagged
 * with its language — a consumer's own highlighter can finish the job, which
 * is what Notion's HTML export settles for in every case.
 */
function codeHtml(block: Block): string {
  const language = String(block.props?.['language'] ?? 'plain');
  const code = plainText(block.text);
  const cls = `language-${escapeHtml(language)}`;
  if (!isLoaded(language)) return `<pre><code class="${cls}">${escapeHtml(code)}</code></pre>`;
  let at = 0;
  let out = '';
  for (const token of tokenize(code, language)) {
    out += escapeHtml(code.slice(at, token.start));
    out += `<span class="nbe-tok-${token.group}">${escapeHtml(code.slice(token.start, token.end))}</span>`;
    at = token.end;
  }
  out += escapeHtml(code.slice(at));
  return `<pre><code class="${cls}">${out}</code></pre>`;
}

/**
 * The code block, minus its editing behaviour.
 *
 * @remarks
 * `inline: true` because a code block *is* text — one leaf, one caret, the
 * same rich-text machinery as a paragraph. What makes it a code block is the
 * font, the fence it projects to, and the colours painted over it; none of
 * that is a different kind of document node.
 *
 * @category Plugins
 */
export const codePlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'code',
    version: 1,
    inline: true,
    // what is typed is what is stored: no autoformat, no Markdown on paste
    literal: true,
    defaultProps: { language: 'plain' },
    placeholder: 'Code',
  },
  // ``` opens a code block, the way `- ` opens a list. A block plugin brings
  // its own markdown shortcut rather than core knowing the syntax.
  autoformat: [{ prefix: '```', type: 'code' }],
  markdown: codeMarkdown,
  html: codeHtml,
};

/** @category Plugins */
export const codeBlocks: BlockPlugin[] = [codePlugin];
