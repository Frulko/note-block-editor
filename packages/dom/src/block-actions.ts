import type { Block, BlockId } from '@nbe/core';
import { getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { createDropZone, fileToDataUrl, openIconPicker, type MenuEntry } from './ui';
import { viewOf } from './block-view';
import { openPagePicker } from './page-picker';
import { loneLink, offerLinkTreatments } from './link-paste';
import { format } from './labels';

/**
 * Per-block-type actions contributed to the block menu (the ⋮⋮ handle).
 * This is the extension point for anything that only makes sense for one
 * kind of block — a callout's icon, a code block's language — so the generic
 * menu never grows type-specific branches, and custom blocks can register
 * their own without touching controls.ts.
 */

export interface BlockActionContext {
  view: EditorView;
  /** The blocks the menu was opened on; the first one drives type-specific UI. */
  ids: BlockId[];
  block: Block;
  /** Element to anchor sub-popovers to. */
  anchor: HTMLElement;
  /** Close the block menu (call before opening a popover of your own). */
  close: () => void;
}

export type BlockActionProvider = (ctx: BlockActionContext) => MenuEntry[];

const providers = new Map<string, BlockActionProvider>();

export function registerBlockActions(type: string, provider: BlockActionProvider): void {
  providers.set(type, provider);
}

export function blockActionEntries(ctx: BlockActionContext): MenuEntry[] {
  // a registered plugin owns its actions; the module registry is what the
  // not-yet-extracted block types still use
  const plugin = viewOf(ctx.view.plugins.get(ctx.block.type));
  if (plugin?.actions) {
    return plugin.actions({ ...ctx, setProps: (props) => setProps(ctx, props) });
  }
  return providers.get(ctx.block.type)?.(ctx) ?? [];
}

const setProps = (ctx: BlockActionContext, props: Record<string, unknown>) =>
  ctx.view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: ctx.block.id, patch: { props } }), {
    origin: 'ui',
  });

// --- built-in providers -----------------------------------------------

registerBlockActions('image', (ctx) => {
  const labels = ctx.view.labels;
  const zone = createDropZone({
    label: labels.replaceImage,
    icon: 'image',
    onFile: async (file) => {
      const store = ctx.view.options.onStoreAsset;
      setProps(ctx, { src: store ? await store(file) : await fileToDataUrl(file) });
      ctx.close();
    },
    onUrl: (src) => {
      setProps(ctx, { src });
      ctx.close();
    },
  });
  return [{ kind: 'section', label: 'Image' }, { kind: 'custom', el: zone }];
});

registerBlockActions('to_do', (ctx) => {
  const labels = ctx.view.labels;
  return [
  {
    label: ctx.block.props['checked'] === true ? labels.uncheck : labels.check,
    onSelect: () => {
      const checked = ctx.block.props['checked'] !== true;
      ctx.view.editor.dispatch(
        (tx) => {
          for (const id of ctx.ids) {
            if (getBlock(ctx.view.editor.doc, id).type === 'to_do') {
              tx.op({ type: 'update_block', id, patch: { props: { checked } } });
            }
          }
        },
        { origin: 'ui' },
      );
    },
  },
  ];
});

/**
 * A page link points somewhere, and somewhere is a thing you change.
 *
 * @remarks
 * Registered for both types: a `sub_page` says the page lives here and a
 * `link_to_page` says it is mentioned here, but "which page" is the same
 * question. Absent without an `onSearchPages` host rather than present and
 * dead, which is the rule the `@` picker and the « Page » entry already follow.
 */
for (const type of ['link_to_page', 'sub_page']) {
  registerBlockActions(type, (ctx) => {
    if (!ctx.view.options.onSearchPages) return [];
    return [
      {
        label: ctx.view.labels.choosePage,
        icon: 'search',
        onSelect: () => {
          // the block menu first: two floating menus anchored to the same
          // handle is one of them measuring a detached element
          const rect = ctx.anchor.getBoundingClientRect();
          ctx.close();
          openPagePicker(ctx.view, ctx.block.id, () => rect);
        },
      },
    ];
  });
}

/**
 * A paragraph that is nothing but a link is a link somebody meant as a block.
 *
 * @remarks
 * The paste offers this at the moment the URL arrives; this is the same offer
 * for the ones that were already there — a note written elsewhere, a link
 * pasted before the editor could ask. Absent for every other paragraph, and
 * absent entirely without an `embed` block registered.
 */
registerBlockActions('paragraph', (ctx) => {
  const at = loneLink(ctx.view, ctx.block.id);
  if (!at || !ctx.view.editor.schema.has('embed')) return [];
  return [
    {
      label: ctx.view.labels.convertToEmbed,
      icon: 'workflow',
      onSelect: () => {
        ctx.close();
        offerLinkTreatments(ctx.view, at);
      },
    },
  ];
});
