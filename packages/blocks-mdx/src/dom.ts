/**
 * How an MDX component looks in the editor: like what it is, or like what the
 * host says it is.
 *
 * @module @nbe/blocks-mdx/dom
 */
import { componentName, mdxPlugin } from './index';
import { parseProps, readTag, type MdxComponents } from './components';
import type { DomBlockPlugin } from '@nbe/dom';

export interface MdxOptions {
  /**
   * Components the host knows how to draw, by tag name.
   *
   * @remarks
   * The file gives the name and the props; this gives the behaviour. Nothing
   * out of the file is executed to get there — see `./components`. A name that
   * is not here renders as the source card, so this is purely additive.
   *
   * @example
   * ```ts
   * createMdx({ components: { Counter: ({ props }) => counterEl(Number(props.start ?? 0)) } })
   * ```
   */
  components?: MdxComponents;
}

/** The card that shows a component as what it is: its name and its source. */
function sourceCard(source: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'nbe-mdx';
  const tag = document.createElement('span');
  tag.className = 'nbe-mdx-name';
  tag.textContent = `<${componentName(source)}>`;
  const body = document.createElement('pre');
  body.className = 'nbe-mdx-source';
  body.textContent = source;
  card.append(tag, body);
  return card;
}

/**
 * The MDX block, optionally with the host's own components.
 *
 * @remarks
 * `mdx` is `createMdx()` — no components, the source card, exactly as before.
 *
 * @category Plugins
 */
export function createMdx(options: MdxOptions = {}): DomBlockPlugin {
  const components = options.components ?? {};
  return {
    ...mdxPlugin,
    view: {
      render(ctx, block) {
        const source = String(block.props['source'] ?? '');
        ctx.root.setAttribute('contenteditable', 'false');

        const tag = readTag(source);
        const renderer = tag ? components[tag.name] : undefined;
        const rendered = renderer
          ? renderer({ name: tag!.name, props: parseProps(tag!.openingTag), children: tag!.children, source })
          : null;

        if (rendered) {
          rendered.classList.add('nbe-mdx-live');
          /*
           * Keyed by the source, so `replaceBlockEl` moves this node into the
           * next render instead of building a second one. Without it a
           * component with state — a counter, an open/closed panel — reset
           * every time anything else in the document was typed, which reads as
           * the component being broken rather than as a re-render.
           */
          rendered.dataset['nbeLive'] = `mdx:${source}`;
          ctx.root.append(rendered);
        } else {
          ctx.root.append(sourceCard(source));
        }
        return ctx.root;
      },

      slash: [
        {
          label: 'Composant',
          keywords: ['mdx', 'composant', 'component', 'jsx'],
          icon: 'code',
          // the label alone does not place it: « Composant » says nothing about
          // which world it belongs to, and the tag says it without lengthening
          // the thing a reader actually scans
          hint: 'mdx',
          props: { source: '<Composant />' },
        },
        ...Object.keys(components).map((name) => ({
          label: name,
          keywords: ['mdx', 'composant', 'component', name.toLowerCase()],
          icon: 'code',
          hint: 'mdx',
          props: { source: `<${name} />` },
        })),
      ],

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
/* a component the host draws is the host's to style; all this owes it is a
   line saying "this came from a tag in the file, not from the prose" */
.nbe-mdx-live {
  border-left: 2px solid var(--nbe-accent-line);
  padding-left: 10px;
}
`,
    },
  };
}

/** The block with no host components: the source card, and nothing runs. */
export const mdx: DomBlockPlugin = createMdx();

export { mdxPlugin, mdxMarkdown, mdxBlocks, componentName } from './index';
export { parseProps, readTag } from './components';
export type { MdxComponents, MdxComponentContext, MdxComponentRenderer } from './components';
