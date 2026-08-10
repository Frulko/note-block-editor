import type { Block, Run } from '@nbe/core';
import { getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { EMPTY_LINE } from './topology';
import { viewOf, type BlockRenderContext } from './block-view';
import { renderDatabase } from './database';
import { createDropZone, fileToDataUrl, icon } from './ui';
import { DEFAULT_ALIGN, resizeHandles } from './media-resize';
import { backgroundColor, textColor } from './colors';
import { format } from './labels';

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/**
 * A URL the sandboxed frame can actually load, whatever the host resolved.
 *
 * @remarks
 * The embed asks for `allow-scripts` **without** `allow-same-origin`, which
 * gives the frame an opaque origin — and an opaque origin cannot navigate to a
 * host's private scheme. In the browser the question never came up, because
 * the asset store already hands back a `blob:`; inside Obsidian
 * `resolveAssetUrl` returns an `app://` resource path and the frame stayed
 * blank with nothing in the console to say why.
 *
 * So the bytes are fetched once and re-served as a blob. Cached by src, which
 * is not only about the leak: a fresh object URL per render would reload the
 * page inside the frame — losing whatever it had on screen — every time the
 * block was re-rendered.
 *
 * @param url - What the host resolved; returned unchanged when it is already
 * something an opaque origin can read.
 */
const sandboxUrls = new Map<string, Promise<string>>();

/** Test seam: the cache is module state, and each case must start from empty. */
export function __resetSandboxUrls(): void {
  sandboxUrls.clear();
}

export function sandboxUrl(url: string): Promise<string> {
  if (/^(blob|data):/i.test(url)) return Promise.resolve(url);
  const cached = sandboxUrls.get(url);
  if (cached) return cached;
  const promise = fetch(url)
    .then((r) => r.blob())
    .then((blob) => URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'text/html' })))
    // a host whose scheme refuses `fetch` too: the frame gets the raw URL, which
    // is exactly what it got before, rather than nothing at all
    .catch(() => url);
  sandboxUrls.set(url, promise);
  return promise;
}

/** Default box for a dropped page, and for a PDF, in CSS pixels. */
const HTML_HEIGHT = 420;
const PDF_HEIGHT = 640;

/**
 * The box a framed attachment lives in: its width, its height, its handles.
 *
 * @remarks
 * The same three-handle sizer the embed block uses, for the same reason — a
 * block is the width of the text column by definition, so dragging *it* would
 * mean nothing, and a frame is the one surface whose height nothing on the
 * page can infer. Width is a share of the column, height is pixels.
 */
function framedSurface(block: Block, child: HTMLElement, fallbackHeight: number): HTMLElement {
  const sizer = el('div', 'nbe-file-sizer');
  sizer.dataset['nbeResizable'] = '';
  sizer.dataset['nbeFullscreen'] = '';
  sizer.style.width = `${Math.min(100, Math.max(10, Number(block.props['width'] ?? 100)))}%`;
  sizer.style.height = `${Math.max(80, Number(block.props['height'] ?? 0) || fallbackHeight)}px`;
  sizer.append(child, ...resizeHandles({ vertical: true }));
  return sizer;
}

/**
 * Which held-back frames have been asked for, by block id.
 *
 * @remarks
 * Pressing play is a decision about *this reading*, not about the note — it
 * must not write to the document, or opening a page would dirty every file in
 * it. Module state rather than a dataset flag because a re-render builds a new
 * element, and rather than a prop because the note is not the place for it.
 */
const playing = new Set<string>();

/** Test seam, and what a fresh mount is entitled to assume. */
export function __resetPlaying(): void {
  playing.clear();
}

/**
 * A page that is not loaded yet, and the button that loads it.
 *
 * @remarks
 * A dropped `.html` is somebody's whole prototype — a canvas, a physics loop,
 * a WebGL scene — and mounting five of them in a note starts five of those the
 * moment it opens, before anyone has looked at one. `loading="lazy"` is not an
 * answer: it defers the fetch until the frame is near the viewport, and then
 * runs the thing anyway. Holding the frame back entirely is, and it costs one
 * press. `autoplay: true` in the block's props is the opt-out, per file.
 */
function poster(view: EditorView, name: string, id: string, build: () => HTMLElement): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nbe-file-poster';
  button.setAttribute('contenteditable', 'false');
  button.dataset['nbeUi'] = '';
  const badge = el('span', 'nbe-file-poster-play');
  badge.append(icon('play', { size: 26 }));
  const caption = el('span', 'nbe-file-poster-name');
  caption.textContent = name;
  button.append(badge, caption);
  button.setAttribute('aria-label', `${view.labels.loadFrame} — ${name}`);
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => {
    playing.add(id);
    button.replaceWith(build());
  });
  return button;
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
  /*
   * The thread a comment mark points at, in the DOM. It is what makes the
   * highlight *clickable*: the stylesheet has drawn this span with
   * `cursor: pointer` since comments shipped, and nothing was listening,
   * because the mark's `threadId` never reached the element.
   */
  const comment = run.marks.find((m) => m.type === 'comment');
  const threadId = comment?.attrs?.['threadId'];
  if (typeof threadId === 'string' && threadId) (span as HTMLElement).dataset['threadId'] = threadId;
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
  markEmptyLines(leaf);
  return leaf;
}

/**
 * Give every empty line a character to hold the caret.
 *
 * @remarks
 * A line with nothing on it gets no caret. Measured in Chromium, in the real
 * editor: a collapsed range at the start of an empty line — trailing *or* in
 * the middle — reports a zero-height box, whether it was put there by an arrow
 * key or by us, which means the browser draws no caret at all. So pressing
 * Enter in a code block opened a line and left the caret nowhere visible: the
 * block grew, nothing else appeared to happen, and the natural read was
 * "Enter added a gap instead of a line".
 *
 * A `::after` was the first attempt and it fixed the wrong half — generated
 * content gives the line its height, and no caret can be placed inside it. A
 * `<br>` does not work either (measured: still no box). The one thing that
 * does is a real character on the line, so the sentinel is a real text node.
 *
 * It carries no model text: {@link leafText} strips it, `domToModelPoint`
 * discounts it, and `modelPointToDom` deliberately aims at it — the offset it
 * shares with the end of the line above is the same model offset, and only one
 * of the two can be drawn.
 *
 * ponytail: the browser still counts it as a position, so an arrow key crossing
 * an empty line stops there once with nothing to show for it. Fixing that means
 * intercepting arrows over sentinels; an invisible caret was the worse bug.
 */
function markEmptyLines(leaf: HTMLElement): void {
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const last = nodes.at(-1);
  for (const node of nodes) {
    const text = node.textContent ?? '';
    // backwards: splitting a node leaves every earlier offset in it valid
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] !== '\n') continue;
      // a line with no character on it: the next one is a break too, or the
      // text ends here and the last line is the empty one
      if (text[i + 1] !== '\n' && !(i === text.length - 1 && node === last)) continue;
      // splitting at the very end would leave an empty node behind; there is
      // nothing to split there, only somewhere to insert
      const tail = i + 1 < node.length ? node.splitText(i + 1) : node.nextSibling;
      node.parentNode?.insertBefore(document.createTextNode(EMPTY_LINE), tail);
    }
  }
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
      const align = String(block.props['align'] ?? DEFAULT_ALIGN);
      const width = Number(block.props['width'] ?? 100);
      root.classList.add(`nbe-align-${align}`);
      const figure = el('figure', 'nbe-figure');
      figure.style.width = `${Math.min(100, Math.max(10, width))}%`;
      // the surface a drag on either edge resizes; the handles ride inside it
      // so a re-render keeps them rather than a floating layer having to
      // re-place itself
      figure.dataset['nbeResizable'] = '';
      figure.append(...resizeHandles());
      const img = document.createElement('img');
      img.className = 'nbe-image';
      // survives a re-render of the block: a fresh <img> flashes while it
      // decodes, and sizing one is a re-render on every drag (see
      // `replaceBlockEl`)
      img.dataset['nbeLive'] = `image:${src}`;
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
    const isHtml = mime === 'text/html' || /\.html?(?:[?#]|$)/i.test(src);
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

    /*
     * A dropped HTML page runs, in a box that can reach nothing.
     *
     * `sandbox="allow-scripts"` and deliberately **not** `allow-same-origin`:
     * together those two undo the sandbox entirely, and apart they give exactly
     * what a dropped prototype needs — its own scripts, its own opaque origin,
     * no access to the vault, the host's storage, its cookies or its DOM. There
     * is no message channel either, by decision: an SDK across that boundary is
     * a protocol, and a protocol is a thing to design rather than to leave
     * open.
     *
     * ponytail: one self-contained file. A folder or a zip needs its relative
     * assets rewritten to blob URLs before any of it resolves — the next rung,
     * and a different amount of work.
     */
    if (isHtml) {
      const buildFrame = (): HTMLIFrameElement => {
        const frame = document.createElement('iframe');
        frame.className = 'nbe-file-embed';
        // a re-render must not reload the page inside it: `replaceBlockEl` moves
        // this node into the new element rather than building a second one
        frame.dataset['nbeLive'] = `file:${src}`;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('loading', 'lazy');
        frame.title = name;
        void Promise.resolve(view.options.resolveAssetUrl?.(src) ?? src)
          .then(sandboxUrl)
          .then((url) => {
            frame.src = url;
          });
        return frame;
      };
      root.append(
        framedSurface(
          block,
          block.props['autoplay'] === true || playing.has(block.id) ? buildFrame() : poster(view, name, block.id, buildFrame),
          HTML_HEIGHT,
        ),
      );
    }

    const preview = !isHtml && isPdf ? document.createElement('object') : null;
    if (preview) {
      preview.className = 'nbe-file-preview';
      preview.dataset['nbeLive'] = `pdf:${src}`; // keeps the reader's page across a re-render
      preview.type = 'application/pdf';
      // the fallback child, shown by the browser when it has no viewer
      const alt = document.createElement('a');
      alt.className = 'nbe-file-link';
      alt.textContent = name;
      preview.append(alt);
      root.append(framedSurface(block, preview, PDF_HEIGHT));
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
    // `labels.untitled`, not a French literal: this was the last one left in
    // the renderer, and it is what an empty page link shows until it is pointed
    // at something
    title.textContent = String(block.props['title'] ?? '') || view.labels.untitled;
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
