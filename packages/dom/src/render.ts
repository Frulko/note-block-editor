import type { Block, Run } from '@nbe/core';
import { getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { viewOf, type BlockRenderContext } from './block-view';
import { renderDatabase } from './database';
import { createDropZone, fileToDataUrl, icon } from './ui';
import { backgroundColor, textColor } from './colors';
import { format } from './labels';

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/** Bytes, as a person reads them. Base 10, because that is what a file manager shows. */
function formatBytes(n: number): string {
  if (n < 1000) return `${n} o`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(0)} Ko`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1e6).toFixed(1)} Mo`;
  return `${(n / 1e9).toFixed(1)} Go`;
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
    // a wikilink's original target (may differ from the shown text); hosts
    // that navigate by name — a vault, not a workspace — read it from here
    const target = String(mention.attrs?.['target'] ?? '');
    if (target) span.dataset['target'] = target;
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
  /*
   * A newline at the very end of the text generates no line box — CSS says an
   * empty last line is not rendered, which is the same reason a contenteditable
   * traditionally needs a trailing `<br>`. Measured: pressing Enter at the end
   * of a code block left the leaf exactly one line tall and the caret with **no
   * client rect at all**, so "Enter does nothing" was literally what it looked
   * like. The zero-width space is a `::after`, not a node: it gives the last
   * line something to be, and `textContent` — which the reconciler and the
   * foreign-mutation defence both compare against the model — does not see a
   * pseudo-element.
   */
  if ((block.text ?? []).at(-1)?.text.endsWith('\n')) leaf.dataset['trailingBreak'] = '';
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

/**
 * A block whose type no plugin claims.
 *
 * @remarks
 * The document model keeps such a block on purpose — a file written with a
 * bigger plugin set than the one reading it must not lose content, and
 * `@nbe/markdown` round-trips it through an `<!-- nbe:type -->` marker. What
 * was missing was the other half: the renderer read its spec and threw, which
 * took the whole page down instead of the one block. So it renders as itself,
 * says which plugin is missing, and its children still render under it.
 */
function renderUnknown(view: EditorView, block: Block): HTMLElement {
  const root = el('div', 'nbe-block nbe-t-unknown');
  root.dataset['blockId'] = block.id;
  root.dataset['unknownType'] = block.type;
  root.setAttribute('contenteditable', 'false');
  const row = el('div', 'nbe-unknown-row');
  row.append(icon('alert-triangle', { size: 15 }));
  const label = el('span');
  label.textContent = format(view.labels.unknownBlock, { type: block.type });
  row.append(label);
  root.append(row);
  // the content is still in the document; showing it beats an empty warning
  for (const childId of block.children) root.append(renderBlock(view, childId));
  return root;
}

export function renderBlock(view: EditorView, id: string): HTMLElement {
  const block = getBlock(view.editor.doc, id);
  if (!view.editor.schema.has(block.type)) return renderUnknown(view, block);
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

  /*
   * Layout containers render their children directly, no row and no leaf —
   * read from the schema rather than from a list of type names, so a plugin's
   * container (a table row) needs no `render` of its own to be laid out like
   * the built-in ones.
   */
  if (spec.layout && block.type !== 'page') {
    if (block.type === 'column' && typeof block.props['ratio'] === 'number')
      root.style.flexGrow = String(block.props['ratio']);
    for (const childId of block.children) root.append(renderBlock(view, childId));
    plugin?.decorate?.(renderCtx, block);
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

  if (block.type === 'file') {
    root.setAttribute('contenteditable', 'false');
    const src = String(block.props['src'] ?? '');
    const name = String(block.props['name'] ?? '') || view.labels.fileFallbackName;
    const mime = String(block.props['mime'] ?? '');
    if (!src) {
      const setSrc = (props: Record<string, unknown>) =>
        view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: block.id, patch: { props } }), {
          origin: 'ui',
        });
      root.append(
        createDropZone({
          label: view.labels.chooseFile,
          icon: 'file-text',
          accept: '*/*',
          onFile: async (file) => {
            const store = view.options.onStoreAsset;
            setSrc({
              src: store ? await store(file) : await fileToDataUrl(file),
              name: file.name,
              size: file.size,
              mime: file.type,
            });
          },
          onUrl: (url) => setSrc({ src: url }),
        }),
      );
      return root;
    }
    /*
     * A PDF previews in the browser's own viewer. `<object>` rather than
     * `<iframe>` for two reasons: it is the only one of the three with native
     * fallback content, so "no viewer here" degrades to the download link
     * with no JavaScript — and it takes an explicit `type`, which matters
     * because an object URL built from stored bytes may carry no Content-Type
     * at all.
     */
    const isPdf = mime === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(src);
    const card = el('div', 'nbe-file');
    const link = document.createElement('a');
    link.className = 'nbe-file-link';
    link.download = name;
    link.append(icon('file-text', { size: 18 }), Object.assign(document.createElement('span'), { textContent: name }));
    const size = Number(block.props['size'] ?? 0);
    if (size > 0) {
      const tag = el('span', 'nbe-file-size');
      tag.textContent = formatBytes(size);
      link.append(tag);
    }
    card.append(link);

    const preview = isPdf ? document.createElement('object') : null;
    if (preview) {
      preview.className = 'nbe-file-preview';
      preview.type = 'application/pdf';
      // the fallback child, shown by the browser when it has no viewer
      const alt = document.createElement('a');
      alt.className = 'nbe-file-link';
      alt.textContent = name;
      preview.append(alt);
      root.append(preview);
      // `<object data>` does not reliably re-fetch when the attribute is set
      // on a live element, so the resolved URL is applied before it is attached
      const attach = (url: string) => {
        preview.data = url;
        alt.href = url;
      };
      const resolved = view.options.resolveAssetUrl?.(src) ?? src;
      if (typeof resolved === 'string') attach(resolved);
      else void resolved.then((url) => attach(url));
    }
    const resolvedHref = view.options.resolveAssetUrl?.(src) ?? src;
    if (typeof resolvedHref === 'string') link.href = resolvedHref;
    else void resolvedHref.then((url) => (link.href = url));
    root.append(card);
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
      const open = block.props['collapsed'] !== true;
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', view.labels.toggle);
      // the same chevron the slash menu offers this block under, drawn rather
      // than typed: a glyph inherits whatever face the host set and lands at a
      // different size and baseline in each one
      btn.append(icon('chevron-right', { size: 16 }));
      if (open) btn.classList.add('nbe-open');
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

  // a plugin's last word on the element the default path built
  plugin?.decorate?.(renderCtx, block);

  const collapsed = block.type === 'toggle' && block.props['collapsed'] === true;
  if (block.children.length && !collapsed) {
    const kids = el('div', 'nbe-children');
    for (const childId of block.children) kids.append(renderBlock(view, childId));
    root.append(kids);
  }
  return root;
}
