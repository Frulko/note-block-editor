/**
 * The callout's editing behaviour: its chrome, its gutter actions, its slash
 * entries and its turn-into target.
 *
 * This entry depends on `@nbe/dom`; the package's main entry does not. That
 * split is what lets `@nbe/markdown` and `@nbe/static-renderer` consume the
 * same block without ever importing the editor view — the layering §9 requires
 * and CI enforces.
 *
 * @module @nbe/blocks-callout/dom
 */
import { createActionButton, openIconPicker, type DomBlockPlugin } from '@nbe/dom';
import { calloutPlugin, CALLOUT_PRESETS } from './index';

const ICON_IS_IMAGE = /^(data:|https?:|asset:)/;

/**
 * The callout, ready to mount.
 *
 * @example
 * ```ts
 * import { callout } from '@nbe/blocks-callout/dom'
 * new EditorView(el, editor, { blocks: [callout] })
 * ```
 *
 * @category Plugins
 */
export const callout: DomBlockPlugin = {
  ...calloutPlugin,
  view: {
    chrome(ctx, block) {
      // through the factory like every other action, so it can never ship
      // without a tooltip and an accessible name
      const icon = createActionButton({
        title: "Changer l'icône du callout",
        className: 'nbe-callout-icon',
        popover: true,
        onClick: () => {}, // the delegated handler in input.ts opens the picker
      });
      const value = String(block.props['icon'] ?? '💡');
      if (ICON_IS_IMAGE.test(value)) {
        const img = document.createElement('img');
        img.className = 'nbe-callout-image';
        const resolved = ctx.view.options.resolveAssetUrl?.(value) ?? value;
        if (typeof resolved === 'string') img.src = resolved;
        else void resolved.then((url) => (img.src = url));
        icon.append(img);
      } else {
        icon.textContent = value;
      }
      return icon;
    },

    actions(ctx) {
      return [
        {
          label: "Changer l'icône",
          icon: String(ctx.block.props['icon'] ?? '💡').slice(0, 2),
          onSelect: () => {
            ctx.close();
            openIconPicker(() => ctx.anchor.getBoundingClientRect(), {
              current: String(ctx.block.props['icon'] ?? ''),
              emojis: ctx.view.options.emojis,
              labels: ctx.view.labels,
              storeImage: ctx.view.options.onStoreAsset,
              // an explicit icon choice drops the preset label but keeps its tint
              onPick: (icon) => ctx.setProps({ icon, variant: undefined }),
              onRemove: () => ctx.setProps({ icon: undefined, variant: undefined }),
            });
          },
        },
        { kind: 'section', label: 'Type' },
        ...CALLOUT_PRESETS.map((preset) => ({
          label: preset.label,
          icon: preset.icon,
          hint: (ctx.block.props['variant'] ?? 'note') === preset.name ? '✓' : undefined,
          onSelect: () =>
            ctx.setProps({
              variant: preset.name,
              icon: preset.icon,
              backgroundColor: preset.backgroundColor,
            }),
        })),
      ];
    },

    // one block type, several entries: the presets are worth reaching directly
    slash: [
      { label: 'Callout', keywords: ['callout', 'encadré', 'note'], icon: '💡' },
      ...CALLOUT_PRESETS.filter((p) => p.name !== 'note' && p.name !== 'quote').map((p) => ({
        label: p.label,
        keywords: [p.name, 'callout'],
        icon: p.icon,
        props: { variant: p.name, icon: p.icon, backgroundColor: p.backgroundColor },
      })),
    ],

    turnInto: { label: 'Callout', icon: '💡' },
  },
};

export { calloutMarkdown, CALLOUT_PRESETS } from './index';
