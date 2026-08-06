import type { Block, BlockId } from '@nbe/core';
import { cellPosition, deleteColumn, deleteRow, getBlock, insertColumn, insertRow } from '@nbe/core';
import type { EditorView } from './view';
import { createDropZone, fileToDataUrl, openIconPicker, type MenuEntry } from './ui';
import { CALLOUT_PRESETS } from './callout';

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
  return providers.get(ctx.block.type)?.(ctx) ?? [];
}

const setProps = (ctx: BlockActionContext, props: Record<string, unknown>) =>
  ctx.view.editor.dispatch((tx) => tx.op({ type: 'update_block', id: ctx.block.id, patch: { props } }), {
    origin: 'ui',
  });

// --- built-in providers -----------------------------------------------

registerBlockActions('callout', (ctx) => [
  {
    label: "Changer l'icône",
    icon: String(ctx.block.props['icon'] ?? '💡').slice(0, 2),
    onSelect: () => {
      ctx.close();
      openIconPicker(() => ctx.anchor.getBoundingClientRect(), {
        current: String(ctx.block.props['icon'] ?? ''),
        storeImage: ctx.view.options.onStoreAsset,
        // an explicit icon choice drops the preset label but keeps its tint
        onPick: (icon) => setProps(ctx, { icon, variant: undefined }),
        onRemove: () => setProps(ctx, { icon: undefined, variant: undefined }),
      });
    },
  },
  { kind: 'section', label: 'Type' },
  ...CALLOUT_PRESETS.map((preset) => ({
    label: preset.label,
    icon: preset.icon,
    hint: (ctx.block.props['variant'] ?? 'note') === preset.name ? '✓' : undefined,
    onSelect: () =>
      ctx.view.editor.dispatch(
        (tx) => {
          for (const id of ctx.ids) {
            if (getBlock(ctx.view.editor.doc, id).type !== 'callout') continue;
            tx.op({
              type: 'update_block',
              id,
              patch: {
                props: { variant: preset.name, icon: preset.icon, backgroundColor: preset.backgroundColor },
              },
            });
          }
        },
        { origin: 'ui' },
      ),
  })),
]);

const LANGUAGES = ['plain', 'ts', 'js', 'json', 'html', 'css', 'python', 'rust', 'go', 'sql', 'bash', 'swift'];

registerBlockActions('code', (ctx) => [
  { kind: 'section', label: 'Langage' },
  ...LANGUAGES.map((language) => ({
    label: language,
    hint: (ctx.block.props['language'] ?? 'plain') === language ? '✓' : undefined,
    onSelect: () => setProps(ctx, { language }),
  })),
]);

registerBlockActions('image', (ctx) => {
  const zone = createDropZone({
    label: "Remplacer l'image",
    icon: '🖼️',
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

/**
 * Table actions operate on the cell the caret is in, so the ⋮⋮ menu of a
 * table row is really "what do I do here" rather than a table-wide dialog.
 */
registerBlockActions('table', (ctx) => {
  const doc = ctx.view.editor.doc;
  // the live selection is the block itself by the time this menu opens, so the
  // row and column come from where the caret last was in text
  const caret = ctx.view.lastTextCaret;
  const caretCell = caret ? cellPosition(doc, caret.blockId) : null;
  const position = caretCell?.tableId === ctx.block.id ? caretCell : null;
  const row = position?.row ?? 0;
  const column = position?.column ?? 0;
  const editor = ctx.view.editor;

  return [
    { kind: 'section', label: `Ligne ${row + 1}` },
    { label: 'Insérer une ligne au-dessus', onSelect: () => insertRow(editor, ctx.block.id, row) },
    { label: 'Insérer une ligne en dessous', onSelect: () => insertRow(editor, ctx.block.id, row + 1) },
    { label: 'Supprimer la ligne', onSelect: () => deleteRow(editor, ctx.block.id, row) },
    { kind: 'section', label: `Colonne ${column + 1}` },
    { label: 'Insérer une colonne à gauche', onSelect: () => insertColumn(editor, ctx.block.id, column) },
    { label: 'Insérer une colonne à droite', onSelect: () => insertColumn(editor, ctx.block.id, column + 1) },
    { label: 'Supprimer la colonne', onSelect: () => deleteColumn(editor, ctx.block.id, column) },
    { kind: 'section', label: 'Tableau' },
    {
      label: "Ligne d'en-tête",
      hint: ctx.block.props['headerRow'] !== false ? '✓' : undefined,
      onSelect: () => setProps(ctx, { headerRow: ctx.block.props['headerRow'] === false }),
    },
  ];
});

registerBlockActions('to_do', (ctx) => [
  {
    label: ctx.block.props['checked'] === true ? 'Décocher' : 'Cocher',
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
]);
