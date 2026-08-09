/**
 * How an MDX component looks in the editor: like what it is.
 *
 * @module @nbe/blocks-mdx/dom
 */
import { componentName, mdxPlugin } from './index';
import type { DomBlockPlugin } from '@nbe/dom';

export const mdx: DomBlockPlugin = {
  ...mdxPlugin,
  view: {
    render(ctx, block) {
      const source = String(block.props['source'] ?? '');
      ctx.root.setAttribute('contenteditable', 'false');
      const card = document.createElement('div');
      card.className = 'nbe-mdx';
      const tag = document.createElement('span');
      tag.className = 'nbe-mdx-name';
      tag.textContent = `<${componentName(source)}>`;
      const body = document.createElement('pre');
      body.className = 'nbe-mdx-source';
      body.textContent = source;
      card.append(tag, body);
      ctx.root.append(card);
      return ctx.root;
    },

    styles: `
.nbe-t-mdx_component {
  padding: 2px;
}
.nbe-mdx {
  border: 1px dashed var(--nbe-border-strong);
  border-radius: var(--nbe-radius-sm, 4px);
  padding: 8px 10px;
  background: var(--nbe-surface-sunken);
}
.nbe-mdx-name {
  display: inline-block;
  margin-bottom: 4px;
  font-family: var(--nbe-font-mono);
  font-size: 11px;
  color: var(--nbe-text-light);
}
.nbe-mdx-source {
  margin: 0;
  font-family: var(--nbe-font-mono);
  font-size: 0.85em;
  line-height: 1.5;
  white-space: pre-wrap;
  color: var(--nbe-text-muted);
  overflow-x: auto;
}
`,
  },
};

export { mdxPlugin, mdxMarkdown, mdxBlocks, componentName } from './index';
