import type { Block, BlockId } from '@nbe/core';
import { getBlock, setColumnCount, setColumnRatios } from '@nbe/core';
import type { EditorView } from './view';
import { createActionButton, createMenu, openOverlays, toContainerPoint, type IconName, type MenuEntry } from './ui';
import { viewOf } from './block-view';
import { DEFAULT_ALIGN, requestFullscreen } from './media-resize';
import type { EditorLabels } from './labels';

/**
 * Per-block floating toolbar, anchored to the block's top-right on hover.
 *
 * The second way to configure a block, next to the ⋮⋮ gutter menu: actions
 * that are frequent and visual (an image's alignment, zoom, download, its
 * caption) belong under the pointer, not two clicks deep in a menu. Rare or
 * destructive ones stay in the menu. Block types opt in by registering here.
 */

export interface ToolbarContext {
  view: EditorView;
  block: Block;
  /** Anchor for popovers opened from a button. */
  anchor: HTMLElement;
  setProps: (props: Record<string, unknown>) => void;
}

export interface ToolbarButton {
  icon: IconName;
  title: string;
  /** Shown as pressed. */
  active?: boolean;
  onClick: (ctx: ToolbarContext, button: HTMLElement) => void;
}

export type ToolbarProvider = (ctx: Omit<ToolbarContext, 'anchor'>) => ToolbarButton[];

export interface ToolbarOptions {
  /**
   * Where the bar sits: `inside` the block's top-right corner (an image has
   * room to spare), or `above` it — a table's top-right corner is a cell with
   * text in it.
   */
  placement?: 'inside' | 'above';
}

const providers = new Map<string, ToolbarProvider>();
const options = new Map<string, ToolbarOptions>();

/**
 * Built-in registration, for the types not yet extracted into plugins.
 *
 * @remarks
 * A plugin declares `view.toolbar` instead; that is looked up first. This
 * registry is module-global and therefore shared by two editors on one page —
 * the reason it is being emptied rather than extended.
 */
export function registerBlockToolbar(type: string, provider: ToolbarProvider, opts: ToolbarOptions = {}): void {
  providers.set(type, provider);
  options.set(type, opts);
}

/** A plugin's toolbar wins over the built-in registry. */
function providerFor(view: EditorView, type: string): ToolbarProvider | undefined {
  const declared = viewOf(view.plugins.get(type))?.toolbar;
  // the plugin type carries `anchor`; the bar fills it in per button, so the
  // provider is called without one and never reads it
  if (declared) return (ctx) => declared(ctx as Parameters<typeof declared>[0]) as ToolbarButton[];
  return providers.get(type);
}

function placementFor(view: EditorView, type: string): 'inside' | 'above' {
  return viewOf(view.plugins.get(type))?.toolbarPlacement ?? options.get(type)?.placement ?? 'inside';
}

export function hasBlockToolbar(type: string): boolean {
  return providers.has(type);
}

// --- built-in: images ---------------------------------------------------

/** Built per view, because labels are per view. */
const alignments = (labels: EditorLabels) =>
  [
    { value: 'left', label: labels.alignLeft },
    { value: 'center', label: labels.alignCenter },
    { value: 'right', label: labels.alignRight },
  ] as const;

registerBlockToolbar('image', ({ block, view, setProps }) => {
  const labels = view.labels;
  const ALIGNMENTS = alignments(labels);
  const src = String(block.props['src'] ?? '');
  const align = String(block.props['align'] ?? DEFAULT_ALIGN);
  const width = Number(block.props['width'] ?? 100);

  return [
    {
      icon: 'message-square',
      title: block.props['caption'] ? labels.editCaption : labels.addCaption,
      active: Boolean(block.props['caption']),
      onClick: (ctx, button) => {
        const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
        const wrap = document.createElement('div');
        wrap.className = 'nbe-db-filter';
        const input = document.createElement('input');
        input.className = 'nbe-db-input';
        input.placeholder = labels.captionPlaceholder;
        input.value = String(ctx.block.props['caption'] ?? '');
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key !== 'Enter') return;
          e.preventDefault();
          menu.close();
          setProps({ caption: input.value.trim() || undefined });
        });
        wrap.append(input);
        menu.update([{ kind: 'custom', el: wrap } as MenuEntry]);
        menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
        queueMicrotask(() => input.focus());
      },
    },
    {
      icon: 'columns',
      title: `${labels.alignLeft.split(' ')[0]} : ${ALIGNMENTS.find((a) => a.value === align)?.label ?? ''}`,
      onClick: (_ctx, button) => {
        const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
        menu.update(
          ALIGNMENTS.map((a) => ({
            label: a.label,
            hintIcon: align === a.value ? 'check' : undefined,
            onSelect: () => setProps({ align: a.value }),
          })),
        );
        menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
      },
    },
    {
      icon: 'search',
      title: `${width} %`,
      onClick: (_ctx, button) => {
        const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
        menu.update(
          [50, 75, 100].map((w) => ({
            label: `${w} %`,
            hintIcon: width === w ? 'check' : undefined,
            onSelect: () => setProps({ width: w }),
          })),
        );
        menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
      },
    },
    {
      icon: 'arrow-down',
      title: labels.downloadImage,
      onClick: async () => {
        if (!src) return;
        const url = (await view.options.resolveAssetUrl?.(src)) ?? src;
        const a = document.createElement('a');
        a.href = url;
        a.download = String(block.props['caption'] ?? 'image');
        a.rel = 'noreferrer';
        a.click();
      },
    },
  ];
});

/* --- built-in: a framed attachment -------------------------------------

   Only a file that shows something has a bar: an attachment with nothing but a
   download link has no size to argue about. What it can say is how tall the
   frame is, whether the frame fills the screen, and — for a dropped page —
   whether it is allowed to start on its own. */

registerBlockToolbar('file', ({ block, view, setProps }) => {
  const labels = view.labels;
  const src = String(block.props['src'] ?? '');
  const mime = String(block.props['mime'] ?? '');
  const isHtml = mime === 'text/html' || /\.html?(?:[?#]|$)/i.test(src);
  const isPdf = mime === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(src);
  if (!src || (!isHtml && !isPdf)) return [];

  return [
    ...(isHtml
      ? [
          {
            icon: 'play' as const,
            title: labels.loadFrame,
            active: block.props['autoplay'] === true,
            onClick: () => setProps({ autoplay: block.props['autoplay'] === true ? undefined : true }),
          },
        ]
      : []),
    {
      icon: 'arrow-up-down',
      title: labels.frameHeight,
      onClick: (ctx, button) => {
        const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
        const current = Number(ctx.block.props['height'] ?? 0);
        menu.update(
          [320, 480, 640, 900].map((h) => ({
            label: `${h} px`,
            hintIcon: current === h ? ('check' as const) : undefined,
            onSelect: () => setProps({ height: h }),
          })),
        );
        menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
      },
    },
    {
      icon: 'maximize',
      title: labels.fullscreen,
      onClick: (ctx) => requestFullscreen(ctx.view.blockEl(ctx.block.id)),
    },
  ];
});

/* --- built-in: the column layout ---------------------------------------

   The bar rather than the gutter menu, because a `column_list` is a layout
   container: `standalone` is false for those by design — you act on what they
   hold — so they have no handle and no menu of their own. The bar has a
   different rule: `hostBlock` walks *up* from whatever is hovered to the
   nearest ancestor that registered one, which is the same walk that lets
   hovering a cell configure its table. So pointing at any column reaches the
   layout. `above`, because a column's top-right corner is somebody's text. */

/** The ways `n` columns can sensibly share the width. */
export function columnRatioPresets(
  labels: EditorLabels,
  n: number,
): Array<{ label: string; ratios: number[] }> {
  const equal = { label: labels.columnsEqual, ratios: Array.from({ length: n }, () => 1) };
  const wide = (at: number, label: string) => ({
    label,
    ratios: Array.from({ length: n }, (_, i) => (i === at ? 2 : 1)),
  });
  const presets = [equal, wide(0, labels.columnsWideFirst), wide(n - 1, labels.columnsWideLast)];
  // a middle only exists when there is one; four columns have two of them
  if (n % 2 === 1 && n > 2) presets.splice(1, 0, wide((n - 1) / 2, labels.columnsWideMiddle));
  return presets;
}

registerBlockToolbar(
  'column_list',
  ({ view, block }) => {
    const labels = view.labels;
    const count = block.children.length;
    const ratios = block.children.map((id) => Number(getBlock(view.editor.doc, id).props['ratio'] ?? 1));
    const same = (a: readonly number[], b: readonly number[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    return [
      {
        icon: 'columns',
        title: `${labels.columns} : ${count}`,
        onClick: (_ctx, button) => {
          const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
          menu.update(
            [2, 3, 4, 5].map((n) => ({
              label: labels.columnsCount.replace('{n}', String(n)),
              hintIcon: n === count ? ('check' as const) : undefined,
              onSelect: () => setColumnCount(view.editor, block.id, n),
            })),
          );
          menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
        },
      },
      {
        icon: 'move-horizontal',
        title: labels.columnsRatio,
        onClick: (_ctx, button) => {
          const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
          menu.update(
            columnRatioPresets(labels, count).map((preset) => ({
              label: preset.label,
              hintIcon: same(ratios, preset.ratios) ? ('check' as const) : undefined,
              onSelect: () => setColumnRatios(view.editor, block.id, preset.ratios),
            })),
          );
          menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
        },
      },
    ];
  },
  { placement: 'above' },
);

// --- the floating bar ---------------------------------------------------

export function attachBlockToolbar(view: EditorView): () => void {
  const bar = document.createElement('div');
  bar.className = 'nbe-blocktoolbar';
  bar.setAttribute('contenteditable', 'false');
  bar.setAttribute('data-nbe-ui', '');
  bar.dataset['nbeUi'] = '';
  let currentId: BlockId | null = null;
  let hideTimer = 0;

  const hide = () => {
    currentId = null;
    bar.remove();
  };

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 250);
  };

  const show = (blockEl: HTMLElement) => {
    const id = blockEl.dataset['blockId'];
    if (!id || !view.editor.doc.blocks.has(id)) return hide();
    const block = getBlock(view.editor.doc, id);
    const provider = providerFor(view, block.type);
    if (!provider) return hide();

    clearTimeout(hideTimer);
    currentId = id;
    const setProps = (props: Record<string, unknown>) => {
      view.editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props } }), { origin: 'ui' });
      // the block re-rendered under the bar: rebuild it against the new props,
      // or a toggle would keep showing the state it had before the click
      const fresh = view.blockEl(id);
      if (fresh) show(fresh);
    };

    bar.replaceChildren();
    for (const spec of provider({ view, block, setProps })) {
      const button = createActionButton({
        title: spec.title,
        icon: spec.icon,
        iconSize: 15,
        className: 'nbe-blocktoolbar-btn' + (spec.active ? ' nbe-active' : ''),
        preserveSelection: true,
        popover: true,
        tooltipDelay: 250,
        onClick: () => spec.onClick({ view, block, anchor: button, setProps }, button),
      });
      bar.append(button);
    }
    // inside the editor, like the gutter and for the same reasons: anchored to
    // a block, it must scroll with it and must not leave the editor's box
    view.content.append(bar);
    const rect = blockEl.getBoundingClientRect();
    const above = placementFor(view, block.type) === 'above';
    const at = toContainerPoint(
      view.content,
      rect.right - bar.offsetWidth,
      above ? rect.top - bar.offsetHeight - 4 : rect.top + 6,
    );
    bar.style.left = `${Math.max(0, at.x)}px`;
    bar.style.top = `${Math.max(0, at.y)}px`;
  };

  /** The nearest block *with a toolbar*: hovering a table cell configures the table. */
  const hostBlock = (from: Element | null): HTMLElement | null => {
    // the target is not always an element — `document` gets mousemove too
    let el = (from?.closest?.('.nbe-block') as HTMLElement | null) ?? null;
    while (el) {
      const id = el.dataset['blockId'];
      if (id && view.editor.doc.blocks.has(id) && providerFor(view, getBlock(view.editor.doc, id).type)) return el;
      el = (el.parentElement?.closest?.('.nbe-block') as HTMLElement | null) ?? null;
    }
    return null;
  };

  const onMove = (e: MouseEvent) => {
    /*
     * A menu opened from this bar is anchored to one of its buttons. Scrolling
     * under a stationary cursor fires `mousemove`, the pointer is now over a
     * different block, and the bar is rebuilt or hidden — which detaches that
     * button. A detached element measures as an all-zero rect, `autoUpdate`
     * only guards against `null`, and the menu jumps to the corner of the
     * viewport and stays there. So the bar freezes while anything it opened is
     * still up.
     */
    if (openOverlays().length) return;
    const target = e.target as HTMLElement | null;
    if (target && (bar.contains(target) || target.closest?.('.nbe-menu'))) {
      clearTimeout(hideTimer);
      return;
    }
    const blockEl = hostBlock(target);
    const id = blockEl?.dataset['blockId'];
    if (!id) {
      if (currentId) scheduleHide();
      return;
    }
    if (id !== currentId) show(blockEl!);
  };

  document.addEventListener('mousemove', onMove, { passive: true });
  return () => {
    clearTimeout(hideTimer);
    document.removeEventListener('mousemove', onMove);
    hide();
  };
}
