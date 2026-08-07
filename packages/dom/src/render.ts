import type { Block, Run } from '@nbe/core';
import { columnCount, getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { viewOf, type BlockRenderContext } from './block-view';
import { renderDatabase } from './database';
import { createDropZone, fileToDataUrl, icon } from './ui';
import { backgroundColor, textColor } from './colors';

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function renderRun(view: EditorView, run: Run): Node {
  if (!run.marks?.length) return document.createTextNode(run.text);
  const link = run.marks.find((m) => m.type === 'link');
  const mention = run.marks.find((m) => m.type === 'mention');
  const span = link ? (el('a') as HTMLAnchorElement) : el('span');
  if (link) (span as HTMLAnchorElement).href = String(link.attrs?.['href'] ?? '#');
  span.className = run.marks.map((m) => `nbe-m-${m.type}`).join(' ');
  const color = textColor(run.marks.find((m) => m.type === 'color')?.attrs?.['color']);
  if (color) (span as HTMLElement).style.color = color;
  const highlight = backgroundColor(run.marks.find((m) => m.type === 'background')?.attrs?.['color']);
  if (highlight) (span as HTMLElement).style.background = highlight;
  /*
   * A mention resolves its title at render time, so renaming a page updates
   * every sentence that mentions it. The stored text is the fallback for when
   * the host cannot resolve — an unloaded workspace, a deleted page, a static
   * export — so it degrades to readable text rather than to nothing.
   */
  if (mention) {
    const pageId = String(mention.attrs?.['pageId'] ?? '');
    const live = view.options.resolvePageTitle?.(pageId);
    span.textContent = live ?? run.text;
    span.dataset['pageId'] = pageId;
    if (live === null) span.classList.add('nbe-m-mention-missing');
    return span;
  }
  span.textContent = run.text;
  return span;
}

function renderLeaf(view: EditorView, block: Block): HTMLElement {
  const spec = view.editor.schema.get(block.type);
  const leaf = el('div', 'nbe-leaf');
  leaf.dataset['blockId'] = block.id;
  // editability is the topology's call, not the renderer's — unless the whole
  // view is read-only, in which case no leaf is editable and no caret appears
  if (!view.readOnly) view.topology.prepareLeaf(leaf, block.id);
  leaf.dataset['gramm'] = 'false'; // Grammarly-class extension opt-out (best effort)
  // the spec's placeholder lives in core, which has no language: it is the
  // fallback for a type the labels do not name, never the translation
  const placeholder =
    block.type === 'paragraph'
      ? view.labels.emptyParagraph
      : (view.labels.placeholders[block.type] ?? spec.placeholder ?? '');
  if (placeholder) {
    leaf.dataset['placeholder'] = placeholder;
    // paragraphs: caret-only placeholder (Notion); other types: always when empty
    if (block.type !== 'paragraph') leaf.dataset['phAlways'] = '';
  }
  for (const run of block.text ?? []) leaf.append(renderRun(view, run));
  return leaf;
}

function listNumber(view: EditorView, block: Block): number {
  const parent = getBlock(view.editor.doc, block.parentId!);
  const idx = parent.children.indexOf(block.id);
  let n = 1;
  for (let i = idx - 1; i >= 0; i--) {
    if (getBlock(view.editor.doc, parent.children[i]!).type === 'numbered_list_item') n++;
    else break;
  }
  return n;
}

export function renderBlock(view: EditorView, id: string): HTMLElement {
  const block = getBlock(view.editor.doc, id);
  const spec = view.editor.schema.get(block.type);
  const root = el('div', `nbe-block nbe-t-${block.type}`);
  // a plugin's own rendering wins over the built-in switch; the switch is what
  // the remaining block types have not been extracted from yet
  const plugin = viewOf(view.plugins.get(block.type));
  const renderCtx: BlockRenderContext = { view, root, child: (childId) => renderBlock(view, childId) };
  root.dataset['blockId'] = block.id;
  const color = textColor(block.props['color']);
  if (color) root.style.color = color;
  const background = backgroundColor(block.props['backgroundColor']);
  if (background) {
    root.style.background = background;
    root.classList.add('nbe-tinted');
  }

  if (plugin?.render) return plugin.render(renderCtx, block);

  if (block.type === 'table') {
    // one CSS grid for the whole table: rows are `display: contents`, so every
    // cell is a grid item and column widths are a single template on the table
    const columns = columnCount(view.editor.doc, block.id) || 1;
    const widths = block.props['columnWidths'];
    root.style.gridTemplateColumns = Array.isArray(widths) && widths.length === columns
      ? widths.map((w) => (typeof w === 'number' && w > 0 ? `${w}px` : 'minmax(80px, 1fr)')).join(' ')
      : `repeat(${columns}, minmax(80px, 1fr))`;
    if (block.props['headerRow'] !== false) root.classList.add('nbe-table-header');
    for (const childId of block.children) root.append(renderBlock(view, childId));
    return root;
  }

  // layout containers render their children directly, no row/leaf
  if (block.type === 'table_row' || block.type === 'column_list' || block.type === 'column') {
    if (block.type === 'column' && typeof block.props['ratio'] === 'number')
      root.style.flexGrow = String(block.props['ratio']);
    for (const childId of block.children) root.append(renderBlock(view, childId));
    return root;
  }

  if (block.type === 'image') {
    root.setAttribute('contenteditable', 'false');
    const src = String(block.props['src'] ?? '');
    if (src) {
      const align = String(block.props['align'] ?? 'left');
      const width = Number(block.props['width'] ?? 100);
      root.classList.add(`nbe-align-${align}`);
      const figure = el('figure', 'nbe-figure');
      figure.style.width = `${Math.min(100, Math.max(10, width))}%`;
      const img = document.createElement('img');
      img.className = 'nbe-image';
      img.alt = String(block.props['caption'] ?? '');
      const resolved = view.options.resolveAssetUrl?.(src) ?? src;
      if (typeof resolved === 'string') img.src = resolved;
      else {
        void resolved.then((url) => {
          if (img.isConnected || !img.src) img.src = url;
        });
      }
      figure.append(img);
      const caption = String(block.props['caption'] ?? '');
      if (caption) {
        const figcaption = el('figcaption', 'nbe-figcaption');
        figcaption.textContent = caption;
        figure.append(figcaption);
      }
      root.append(figure);
    } else {
      const setSrc = (src: string) =>
        view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: block.id, patch: { props: { src } } }), {
          origin: 'ui',
        });
      root.append(
        createDropZone({
          label: 'Choisir une image',
          icon: 'image',
          onFile: async (file) => {
            const store = view.options.onStoreAsset;
            setSrc(store ? await store(file) : await fileToDataUrl(file));
          },
          onUrl: setSrc,
        }),
      );
    }
    return root;
  }

  if (block.type === 'database') {
    root.append(renderDatabase(view, block));
    return root;
  }

  if (block.type === 'link_to_page' || block.type === 'sub_page') {
    root.setAttribute('contenteditable', 'false');
    const row = el('div', 'nbe-row nbe-page-link');
    // a sub-page is where the child page lives; a link only points at one
    row.append(icon(block.type === 'sub_page' ? 'file-text' : 'link', { size: 15 }));
    const title = el('span', 'nbe-page-link-title');
    title.textContent = String(block.props['title'] ?? '') || 'Page sans titre';
    row.append(title);
    root.append(row);
    return root;
  }

  const row = el('div', 'nbe-row');

  switch (block.type) {
    case 'heading':
      root.classList.add(`nbe-h${block.props['level'] ?? 1}`);
      break;
    case 'bulleted_list_item': {
      const g = el('div', 'nbe-gutter nbe-bullet');
      g.textContent = '•';
      row.append(g);
      break;
    }
    case 'numbered_list_item': {
      const g = el('div', 'nbe-gutter nbe-number');
      g.textContent = `${listNumber(view, block)}.`;
      row.append(g);
      break;
    }
    case 'to_do': {
      const btn = el('button', 'nbe-checkbox') as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', String(block.props['checked'] === true));
      if (block.props['checked'] === true) root.classList.add('nbe-checked');
      row.append(btn);
      break;
    }
    case 'toggle': {
      const btn = el('button', 'nbe-toggle-arrow') as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('aria-expanded', String(block.props['collapsed'] !== true));
      btn.textContent = '▶';
      if (block.props['collapsed'] !== true) btn.classList.add('nbe-open');
      row.append(btn);
      break;
    }
  }

  const chrome = plugin?.chrome?.(renderCtx, block);
  if (chrome) row.append(chrome);

  if (spec.inline) {
    row.append(renderLeaf(view, block));
    root.append(row);
  } else if (block.type === 'divider') {
    const hr = el('div', 'nbe-divider-line');
    row.append(hr);
    root.append(row);
  } else {
    root.append(row);
  }

  const collapsed = block.type === 'toggle' && block.props['collapsed'] === true;
  if (block.children.length && !collapsed) {
    const kids = el('div', 'nbe-children');
    for (const childId of block.children) kids.append(renderBlock(view, childId));
    root.append(kids);
  }
  return root;
}
