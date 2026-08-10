/**
 * The embed's editing behaviour: the box you paste a link into, the frame it
 * becomes, and the three ways of showing it.
 *
 * @module @nbe/blocks-embed/dom
 */
import type { Block } from '@nbe/core';
import { createDropZone, icon, resizeHandles, type DomBlockPlugin, type EditorView } from '@nbe/dom';
import { embedMode, embedPlugin, frameUrl, providerFor, PROVIDERS, type EmbedMode } from './index';

/** The default height of a frame with no ratio to go on. */
const HEIGHT = 400;

const MODES: ReadonlyArray<{ id: EmbedMode; label: string; icon: string }> = [
  { id: 'iframe', label: 'Intégré', icon: 'workflow' },
  { id: 'card', label: 'Carte', icon: 'link' },
  { id: 'srcdoc', label: 'HTML', icon: 'code' },
];

function setProps(view: EditorView, block: Block, props: Record<string, unknown>): void {
  view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: block.id, patch: { props } }), { origin: 'ui' });
}

/**
 * The frame, sandboxed the same way a dropped `.html` file is.
 *
 * @remarks
 * `allow-scripts` **without** `allow-same-origin` for `srcdoc`, because markup
 * held in the block is markup somebody pasted and the two together undo the
 * sandbox entirely. A provider's own player is a different case: it is a
 * third-party origin doing its own thing, and stripping `allow-same-origin`
 * there breaks every player that stores a preference.
 */
function frame(block: Block, mode: EmbedMode): HTMLIFrameElement {
  const props = block.props ?? {};
  const el = document.createElement('iframe');
  el.className = 'nbe-embed-frame';
  el.setAttribute('loading', 'lazy');
  el.title = String(props['title'] ?? '') || 'Intégration';
  if (mode === 'srcdoc') {
    el.setAttribute('sandbox', 'allow-scripts');
    el.srcdoc = String(props['html'] ?? '');
  } else {
    el.setAttribute('allowfullscreen', '');
    el.src = frameUrl(String(props['src'] ?? '')) ?? '';
  }
  /*
   * What the frame is showing, as a key. A re-render of the block builds a new
   * element and a new frame *reloads* — so sizing an embed used to restart the
   * video it had just been sized around. `replaceBlockEl` moves this node into
   * the new element instead, and only when the key matches: a different page
   * is a different frame, and must load.
   */
  el.dataset['nbeLive'] = `embed:${mode}:${el.src || el.srcdoc}`;
  const height = Number(props['height'] ?? 0);
  const provider = providerFor(String(props['src'] ?? ''));
  el.style.height = height
    ? `${height}px`
    : // a video with a known ratio keeps it; everything else gets a sane box
      provider?.ratio
      ? ''
      : `${HEIGHT}px`;
  if (!height && provider?.ratio) el.style.aspectRatio = String(provider.ratio);
  return el;
}

/** A link with its host's name: what a bookmark is, and what a Gist falls back to. */
function card(view: EditorView, block: Block): HTMLElement {
  const props = block.props ?? {};
  const src = String(props['src'] ?? '');
  const provider = providerFor(src);
  const link = document.createElement('a');
  link.className = 'nbe-embed-card';
  link.href = src;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.append(icon('link', { size: 15 }));
  const title = document.createElement('span');
  title.className = 'nbe-embed-card-title';
  title.textContent = String(props['title'] ?? '') || provider?.label || src;
  link.append(title);
  const host = document.createElement('span');
  host.className = 'nbe-embed-card-host';
  try {
    host.textContent = new URL(src).hostname.replace(/^www\./, '');
  } catch {
    host.textContent = '';
  }
  link.append(host);
  /*
   * ponytail: no title or preview image is fetched. That needs the network,
   * and the network belongs to a host — add an `onResolveEmbed` option when
   * somebody wants real bookmarks, and let this stay the offline answer.
   */
  void view;
  return link;
}

/**
 * The embed, ready to mount.
 *
 * @example
 * ```ts
 * import { embed } from '@nbe/blocks-embed/dom'
 * new EditorView(el, editor, { blocks: [...builtinBlocks, embed] })
 * ```
 *
 * @category Plugins
 */
export const embed: DomBlockPlugin = {
  ...embedPlugin,
  view: {
    render(ctx, block) {
      const view = ctx.view;
      const props = block.props ?? {};
      const src = String(props['src'] ?? '');
      const mode = embedMode(props);
      ctx.root.setAttribute('contenteditable', 'false');
      ctx.root.dataset['embedMode'] = mode;
      // the same class the image uses, so one stylesheet rule serves both and
      // `media-resize` can ask "is this centred" without knowing the type
      ctx.root.classList.add(`nbe-align-${String(props['align'] ?? 'left')}`);

      if (!src && mode !== 'srcdoc') {
        ctx.root.append(
          createDropZone({
            label: view.labels.chooseFile,
            icon: 'link',
            urlPlaceholder: 'Collez un lien, puis Entrée',
            // a file dropped here is a file, and the editor already has a block
            // for that; this zone only exists for its URL field
            onFile: () => {},
            onUrl: (url) => setProps(view, block, { src: url, title: providerFor(url)?.label ?? '' }),
          }),
        );
        return ctx.root;
      }

      /*
       * The frame in a sizer of its own, so the edge handles have something to
       * resize that is not the block: a block is the width of the text column
       * by definition, and dragging *that* would mean nothing.
       */
      const sizer = document.createElement('div');
      sizer.className = 'nbe-embed-sizer';
      sizer.dataset['nbeResizable'] = '';
      sizer.style.width = `${Math.min(100, Math.max(10, Number(props['width'] ?? 100)))}%`;
      sizer.append(mode === 'card' ? card(view, block) : frame(block, mode), ...resizeHandles());
      ctx.root.append(sizer);
      return ctx.root;
    },

    toolbar(ctx) {
      const current = embedMode(ctx.block.props);
      const src = String(ctx.block.props?.['src'] ?? '');
      return [
        ...MODES.filter(
          // "Intégré" is not offered for something that cannot be framed; a
          // button that produces a blank box is worse than a missing button
          (m) => m.id !== 'iframe' || !src || frameUrl(src),
        ).map((m) => ({
          icon: m.icon as 'link',
          title: m.label,
          active: m.id === current,
          onClick: () => ctx.setProps({ mode: m.id }),
        })),
        ...(['alignLeft', 'alignCenter', 'alignRight'] as const).map((key, i) => ({
          icon: (['pilcrow', 'columns', 'pilcrow'] as const)[i]!,
          title: ctx.view.labels[key],
          active: String(ctx.block.props?.['align'] ?? 'left') === ['left', 'center', 'right'][i],
          onClick: () => ctx.setProps({ align: ['left', 'center', 'right'][i] }),
        })),
        {
          icon: 'arrow-up-down' as const,
          title: 'Hauteur',
          onClick: () => {
            const current = Number(ctx.block.props?.['height'] ?? 0) || HEIGHT;
            const next = [240, 400, 600, 800];
            // a cycle rather than a menu: four values, one button, no popover
            ctx.setProps({ height: next[(next.indexOf(current) + 1) % next.length] });
          },
        },
      ];
    },
    toolbarPlacement: 'above',

    slash: [
      {
        label: 'Intégration',
        keywords: ['embed', 'intégration', 'integration', 'iframe', 'lien'],
        icon: 'workflow',
      },
      // named entries for discoverability, one block type underneath — which is
      // the whole point of the table
      ...PROVIDERS.filter((p) => ['youtube', 'vimeo', 'figma', 'loom', 'pdf'].includes(p.id)).map((p) => ({
        label: `Intégration — ${p.label}`,
        keywords: ['embed', 'intégration', p.id, p.label.toLowerCase()],
        icon: 'workflow',
      })),
      {
        label: 'HTML (intégré)',
        keywords: ['html', 'srcdoc', 'code', 'intégration'],
        icon: 'code',
        props: { mode: 'srcdoc', html: '<p>bonjour</p>' },
      },
    ],

    styles: `
.nbe-t-embed {
  padding: 4px 0;
}
.nbe-embed-sizer {
  /* the align classes move this rather than the block: an auto margin on one
     side, on both, or on neither */
  max-width: 100%;
}
.nbe-align-center > .nbe-embed-sizer { margin-inline: auto; }
.nbe-align-right > .nbe-embed-sizer { margin-inline-start: auto; }
.nbe-embed-frame {
  display: block;
  width: 100%;
  border: 1px solid var(--nbe-border);
  border-radius: var(--nbe-radius-sm, 4px);
  background: var(--nbe-surface-sunken);
}
.nbe-embed-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--nbe-border);
  border-radius: var(--nbe-radius-sm, 4px);
  color: inherit;
  text-decoration: none;
}
.nbe-embed-card:hover { background: var(--nbe-hover); }
.nbe-embed-card-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nbe-embed-card-host {
  margin-left: auto;
  color: var(--nbe-text-light);
  font-size: 0.85em;
}
`,
  },
};

export { embedMarkdown, embedMode, embedPlugin, frameUrl, providerFor, PROVIDERS } from './index';
export type { EmbedMode, EmbedProvider } from './index';
