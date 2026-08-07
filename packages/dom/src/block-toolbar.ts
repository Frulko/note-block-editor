import type { Block, BlockId } from '@nbe/core';
import { getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { createActionButton, createMenu, positionFloating, type IconName, type MenuEntry } from './ui';
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

const providers = new Map<string, ToolbarProvider>();

export function registerBlockToolbar(type: string, provider: ToolbarProvider): void {
  providers.set(type, provider);
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
  const align = String(block.props['align'] ?? 'left');
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
            hint: align === a.value ? '✓' : undefined,
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
            hint: width === w ? '✓' : undefined,
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

// --- the floating bar ---------------------------------------------------

export function attachBlockToolbar(view: EditorView): () => void {
  const bar = document.createElement('div');
  bar.className = 'nbe-blocktoolbar';
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
    const provider = providers.get(block.type);
    if (!provider) return hide();

    clearTimeout(hideTimer);
    currentId = id;
    const setProps = (props: Record<string, unknown>) =>
      view.editor.dispatch((tx) => tx.op({ type: 'update_block', id, patch: { props } }), { origin: 'ui' });

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
    document.body.append(bar);
    const rect = blockEl.getBoundingClientRect();
    positionFloating(bar, { top: rect.top, bottom: rect.top, left: rect.right, right: rect.right }, {
      placement: 'bottom-end',
      offset: 6,
    });
  };

  const onMove = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (bar.contains(target) || target.closest?.('.nbe-menu'))) {
      clearTimeout(hideTimer);
      return;
    }
    const blockEl = target?.closest?.('.nbe-block') as HTMLElement | null;
    const id = blockEl?.dataset['blockId'];
    if (!id || !view.editor.doc.blocks.has(id) || !providers.has(getBlock(view.editor.doc, id).type)) {
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
