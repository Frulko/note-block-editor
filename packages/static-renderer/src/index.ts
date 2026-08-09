/**
 * JSON to HTML without an editor instance and without DOM globals — for
 * export, server rendering and static sites.
 *
 * @module @nbe/static-renderer
 */

import type { Block, BlockJSON, PluginRegistry, Run } from '@nbe/core';

/**
 * Static HTML rendering: schema JSON → HTML with no editor instance and no
 * DOM APIs (SSR/CLI safe). Depends on @nbe/core only — never on @nbe/dom
 * (ARCHITECTURE §9). Markdown projection lives in @nbe/markdown.
 */

export interface RenderOptions {
  /** Resolve persisted image srcs (asset:… refs) to loadable URLs. */
  resolveAssetUrl?: (src: string) => string;
  /** Map a page id to an href for link_to_page blocks and page mentions. */
  resolvePageHref?: (pageId: string) => string;
  /** Render a database view block; return '' to skip it. */
  renderDatabase?: (collectionId: string, viewId: string) => string;
  /** CSS class prefix (default 'nbe'), so output can be styled like the editor. */
  classPrefix?: string;
  /** Emit id attributes on block wrappers (per-block anchors). Default true. */
  blockIds?: boolean;
  /**
   * Block plugins whose `html` is consulted before the built-in switch.
   *
   * @remarks
   * Passed per call rather than held in a module registry, for the same reason
   * the editor's registry is per instance: two documents rendered in one
   * process may be edited under different plugin sets. Without it, a plugin's
   * block falls through to the marker comment — visible, never silent.
   */
  plugins?: PluginRegistry;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
};

export function runsToHtml(runs: Run[] | undefined, opts: RenderOptions = {}): string {
  const prefix = opts.classPrefix ?? 'nbe';
  return (runs ?? [])
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/g, '<br>');
      for (const mark of run.marks ?? []) {
        if (mark.type === 'link') {
          const href = escapeHtml(String(mark.attrs?.['href'] ?? '#'));
          html = `<a class="${prefix}-m-link" href="${href}">${html}</a>`;
        } else if (mark.type === 'mention') {
          const pageId = String(mark.attrs?.['pageId'] ?? '');
          const href = opts.resolvePageHref?.(pageId);
          html = href ? `<a class="${prefix}-m-mention" href="${escapeHtml(href)}">${html}</a>` : html;
        } else if (mark.type === 'color' || mark.type === 'background') {
          // colours are persisted as palette NAMES, so the projection emits
          // classes: the consumer's stylesheet owns the actual values and can
          // theme them (a raw CSS colour would freeze one theme into the export)
          const name = String(mark.attrs?.['color'] ?? '').replace(/[^a-z0-9_-]/gi, '');
          if (!name) return html;
          const kind = mark.type === 'color' ? 'color' : 'bg';
          html = `<span class="${prefix}-m-${mark.type} ${prefix}-${kind}-${name}">${html}</span>`;
        } else if (MARK_TAGS[mark.type]) {
          const tag = MARK_TAGS[mark.type]!;
          html = `<${tag} class="${prefix}-m-${mark.type}">${html}</${tag}>`;
        }
      }
      return html;
    })
    .join('');
}

const LIST_WRAPPERS: Record<string, string> = {
  bulleted_list_item: 'ul',
  numbered_list_item: 'ol',
  to_do: 'ul',
};

function blockAttrs(block: BlockJSON, cls: string, opts: RenderOptions): string {
  const p = opts.classPrefix ?? 'nbe';
  const id = opts.blockIds === false ? '' : ` id="${escapeHtml(block.id)}"`;
  const clean = (v: unknown) => String(v ?? '').replace(/[^a-z0-9_-]/gi, '');
  const color = clean(block.props?.['color']);
  const background = clean(block.props?.['backgroundColor']);
  const classes = [cls, color && `${p}-color-${color}`, background && `${p}-bg-${background}`].filter(Boolean);
  return `${id} class="${classes.join(' ')}"`;
}

function renderOne(block: BlockJSON, opts: RenderOptions): string {
  const p = opts.classPrefix ?? 'nbe';
  // a plugin's projection wins over the built-in switch, exactly as in the
  // markdown package — same contract, same precedence, different output
  const plugin = opts.plugins?.get(block.type);
  if (plugin?.html) {
    return plugin.html(block as unknown as Block, {
      depth: 0,
      child: (child) => [renderOne(child as unknown as BlockJSON, opts)],
    });
  }
  const children = renderSiblings(block.children ?? [], opts);
  const inner = runsToHtml(block.text, opts);
  const props = block.props ?? {};
  const attrs = (extra = '') => blockAttrs(block, `${p}-t-${block.type}${extra}`, opts);

  switch (block.type) {
    case 'paragraph':
      return `<p${attrs()}>${inner}</p>${children}`;
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(props['level'] ?? 1)));
      return `<h${level}${attrs()}>${inner}</h${level}>${children}`;
    }
    case 'bulleted_list_item':
    case 'numbered_list_item':
      return `<li${attrs()}>${inner}${children}</li>`;
    case 'to_do': {
      const checked = props['checked'] === true;
      return `<li${attrs(checked ? ` ${p}-checked` : '')}><input type="checkbox" disabled${
        checked ? ' checked' : ''
      }> ${inner}${children}</li>`;
    }
    case 'toggle': {
      const open = props['collapsed'] === true ? '' : ' open';
      return `<details${attrs()}${open}><summary>${inner}</summary>${children}</details>`;
    }
    case 'quote':
      return `<blockquote${attrs()}>${inner}${children}</blockquote>`;
    case 'callout': {
      const icon = escapeHtml(String(props['icon'] ?? '💡'));
      return `<aside${attrs()}><span class="${p}-callout-icon">${icon}</span><div>${inner}${children}</div></aside>`;
    }
    case 'code': {
      const lang = escapeHtml(String(props['language'] ?? 'plain'));
      const raw = escapeHtml((block.text ?? []).map((r) => r.text).join(''));
      return `<pre${attrs()}><code class="language-${lang}">${raw}</code></pre>`;
    }
    case 'divider':
      return `<hr${attrs()}>`;
    case 'image': {
      const rawSrc = String(props['src'] ?? '');
      const src = escapeHtml(opts.resolveAssetUrl?.(rawSrc) ?? rawSrc);
      const caption = escapeHtml(String(props['caption'] ?? ''));
      if (!src) return '';
      return `<figure${attrs()}><img src="${src}" alt="${caption}">${
        caption ? `<figcaption>${caption}</figcaption>` : ''
      }</figure>`;
    }
    case 'link_to_page': {
      const pageId = String(props['pageId'] ?? '');
      const title = escapeHtml(String(props['title'] ?? '') || 'Page');
      const href = opts.resolvePageHref?.(pageId);
      const label = `📄 ${title}`;
      return href
        ? `<p${attrs()}><a href="${escapeHtml(href)}">${label}</a></p>`
        : `<p${attrs()}>${label}</p>`;
    }
    case 'column_list':
      return `<div${attrs()}>${children}</div>`;
    case 'column': {
      const ratio = typeof props['ratio'] === 'number' ? ` style="flex-grow:${props['ratio']}"` : '';
      return `<div${attrs()}${ratio}>${children}</div>`;
    }
    case 'database': {
      const html = opts.renderDatabase?.(String(props['collectionId'] ?? ''), String(props['viewId'] ?? ''));
      return html ?? '';
    }
    case 'page':
      return children;
    default:
      // unknown types round-trip visibly instead of vanishing (§4)
      return `<div${attrs()} data-unknown-type="${escapeHtml(block.type)}">${inner}${children}</div>`;
  }
}

/**
 * Render a sibling list, wrapping runs of consecutive list items in one
 * ul/ol. Only same-type runs merge: to_do and bulleted both use <ul> but a
 * to-do list is never absorbed into a bullet list.
 */
function renderSiblings(blocks: BlockJSON[], opts: RenderOptions): string {
  let out = '';
  let openTag: string | null = null;
  let openType: string | null = null;
  const close = () => {
    if (openTag) out += `</${openTag}>`;
    openTag = null;
    openType = null;
  };
  for (const block of blocks) {
    const tag = LIST_WRAPPERS[block.type];
    if (tag) {
      if (openType !== block.type) {
        close();
        const cls = block.type === 'to_do' ? ` class="${opts.classPrefix ?? 'nbe'}-todo-list"` : '';
        out += `<${tag}${cls}>`;
        openTag = tag;
        openType = block.type;
      }
    } else {
      close();
    }
    out += renderOne(block, opts);
  }
  close();
  return out;
}

/** Render a list of sibling blocks to an HTML fragment. */
export function renderBlocksToHTML(blocks: BlockJSON[], opts: RenderOptions = {}): string {
  return renderSiblings(blocks, opts);
}

/** Render a page (root block) to an HTML fragment. */
export function renderToHTML(root: BlockJSON, opts: RenderOptions = {}): string {
  const prefix = opts.classPrefix ?? 'nbe';
  const body = root.type === 'page' ? renderSiblings(root.children ?? [], opts) : renderOne(root, opts);
  return `<div class="${prefix}-page">${body}</div>`;
}

/** Plain text extraction (search indexes, previews, meta descriptions). */
export function renderToText(block: BlockJSON): string {
  const own = (block.text ?? []).map((r) => r.text).join('');
  const kids = (block.children ?? []).map(renderToText).filter(Boolean);
  return [own, ...kids].filter(Boolean).join('\n');
}
