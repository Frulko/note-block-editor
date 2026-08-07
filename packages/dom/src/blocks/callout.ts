import type { Block } from '@nbe/core';
import { PLUGIN_API_VERSION, plainText } from '@nbe/core';
import { createActionButton, openIconPicker } from '../ui';
import type { DomBlockPlugin } from '../block-view';
import { CALLOUT_PRESETS } from '../callout';

/**
 * The first block expressed as a plugin rather than as branches scattered
 * across the codebase.
 *
 * Before this, `callout` appeared in fourteen files across four packages. Here
 * it is one declaration: schema, chrome, gutter actions, slash entry,
 * turn-into entry, and both directions of the markdown projection. The
 * projection is in this same file *on purpose* — the whole point of declaring
 * the plugin type whole is that a block cannot render without also saying how
 * it survives an export.
 */

const ICON_IS_IMAGE = /^(data:|https?:|asset:)/;

export const calloutPlugin: DomBlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,

  schema: {
    type: 'callout',
    version: 1,
    inline: true,
    defaultProps: { variant: 'note', icon: '💡', backgroundColor: 'gray' },
    placeholder: 'Une note à mettre en avant…',
  },

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

    // one block type, five entries: the presets are worth reaching directly
    slash: [
      { label: 'Callout', keywords: ['callout', 'encadré', 'note'], icon: '💡' },
      ...CALLOUT_PRESETS.filter((p) => p.name !== 'note').map((p) => ({
        label: p.label,
        keywords: [p.name, 'callout'],
        icon: p.icon,
        props: { variant: p.name, icon: p.icon, backgroundColor: p.backgroundColor },
      })),
    ],

    turnInto: { label: 'Callout', icon: '💡' },
  },

  markdown: {
    /**
     * Obsidian's callout convention: the variant *is* the callout type, so a
     * preset round-trips as `> [!warning]` instead of collapsing to note.
     */
    toMarkdown(block, ctx) {
      const pad = '    '.repeat(ctx.depth);
      const variant = typeof block.props['variant'] === 'string' && block.props['variant'] ? block.props['variant'] : 'note';
      const icon = typeof block.props['icon'] === 'string' && block.props['icon'] ? `${block.props['icon']} ` : '';
      const children = (block.children ?? []).flatMap((child) => ctx.child(child as unknown as Block));
      return [`${pad}> [!${variant}] ${icon}${plainText(block.text)}`, ...children.map((l) => `${pad}> ${l}`)];
    },

    fromMarkdown: [
      {
        match: /^>\s?\[!(\w+)\][-+]?\s?(.*)$/,
        parse(lines, start) {
          const m = /^>\s?\[!(\w+)\][-+]?\s?(.*)$/.exec(lines[start] ?? '');
          if (!m) return null;
          // 'note' is the default rendering, so it is never stored — that keeps
          // documents lean and makes the round-trip byte-stable
          const variant = m[1]!.toLowerCase();
          let consumed = 1;
          while (start + consumed < lines.length && /^>\s?/.test(lines[start + consumed] ?? '')) consumed++;
          return {
            block: {
              id: '',
              type: 'callout',
              version: 1,
              props: variant === 'note' ? {} : { variant },
              text: [{ text: m[2] ?? '' }],
              children: [],
              parentId: null,
            },
            consumed,
          };
        },
      },
    ],
  },

  html(block) {
    const icon = String(block.props['icon'] ?? '💡');
    return `<aside class="nbe-t-callout"><span class="nbe-callout-icon">${icon}</span><div>${plainText(block.text)}</div></aside>`;
  },
};
