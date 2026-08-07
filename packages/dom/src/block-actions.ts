import type { Block, BlockId } from '@nbe/core';
import { cellPosition, deleteColumn, deleteRow, getBlock, insertColumn, insertRow } from '@nbe/core';
import type { EditorView } from './view';
import { createDropZone, fileToDataUrl, openIconPicker, type MenuEntry } from './ui';
import { viewOf } from './block-view';
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

const LANGUAGES = ['plain', 'ts', 'js', 'json', 'html', 'css', 'python', 'rust', 'go', 'sql', 'bash', 'swift'];

registerBlockActions('code', (ctx) => {
  const labels = ctx.view.labels;
  return [
  { kind: 'section', label: labels.language },
  ...LANGUAGES.map((language) => ({
    label: language,
    hintIcon: (ctx.block.props['language'] ?? 'plain') === language ? 'check' : undefined,
    onSelect: () => setProps(ctx, { language }),
  })),
  ];
});

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

/**
 * Table actions operate on the cell the caret is in, so the ⋮⋮ menu of a
 * table row is really "what do I do here" rather than a table-wide dialog.
 */
registerBlockActions('table', (ctx) => {
  const labels = ctx.view.labels;
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
    { kind: 'section', label: format(labels.rowN, { n: row + 1 }) },
    { label: labels.insertRowAbove, onSelect: () => insertRow(editor, ctx.block.id, row) },
    { label: labels.insertRowBelow, onSelect: () => insertRow(editor, ctx.block.id, row + 1) },
    { label: labels.deleteRow, onSelect: () => deleteRow(editor, ctx.block.id, row) },
    { kind: 'section', label: format(labels.columnN, { n: column + 1 }) },
    { label: labels.insertColumnLeft, onSelect: () => insertColumn(editor, ctx.block.id, column) },
    { label: labels.insertColumnRight, onSelect: () => insertColumn(editor, ctx.block.id, column + 1) },
    { label: labels.deleteColumn, onSelect: () => deleteColumn(editor, ctx.block.id, column) },
    { kind: 'section', label: labels.table },
    {
      label: labels.headerRow,
      hintIcon: ctx.block.props['headerRow'] !== false ? 'check' : undefined,
      onSelect: () => setProps(ctx, { headerRow: ctx.block.props['headerRow'] === false }),
    },
  ];
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
