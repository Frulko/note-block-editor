import type { Block, BlockId, BlockPlugin, Ranked } from '@nbe/core';
import type { EditorView } from './view';
import type { MenuEntry } from './ui';
import type { IconName } from './ui';

/**
 * The editing-surface half of a block plugin.
 *
 * `BlockPlugin.view` is typed `unknown` in core, because core must never
 * depend on the DOM; this is where it is refined. A plugin package therefore
 * splits by entry point — the schema entry depends on `core`, the `/dom` entry
 * on `dom` — which is what §9 of the architecture always anticipated and what
 * keeps the markdown and static-renderer packages free of DOM.
 *
 * Everything here replaces a closed dispatch that exists today:
 *
 * | contribution | replaces |
 * |---|---|
 * | `render`     | a whole-block branch of `render.ts` |
 * | `chrome`     | a row-decorating case of `render.ts`'s switch |
 * | `actions`    | `block-actions.ts`'s module-global registry |
 * | `toolbar`    | `block-toolbar.ts`'s module-global registry |
 * | `slash`      | an entry of `slash.ts`'s `ITEMS` array |
 * | `turnInto`   | an entry of `block-types.ts`'s `TURN_INTO` |
 * | `keys`       | a branch of `keymap.ts` |
 * | `styles`     | a slice of `style/blocks.css` |
 */

export interface BlockRenderContext {
  view: EditorView;
  /** Render a child block. Containers use this rather than walking themselves. */
  child(id: BlockId): HTMLElement;
  /** The block's outer element, for classes and inline styles. */
  root: HTMLElement;
}

export interface BlockActionContext {
  view: EditorView;
  /** The blocks the menu was opened on; the first drives type-specific UI. */
  ids: BlockId[];
  block: Block;
  /** Element to anchor a popover to. */
  anchor: HTMLElement;
  /** Close the block menu before opening a popover of your own. */
  close: () => void;
  /** Patch this block's props — the commonest thing an action does. */
  setProps: (props: Record<string, unknown>) => void;
}

export interface BlockToolbarContext {
  view: EditorView;
  block: Block;
  anchor: HTMLElement;
  setProps: (props: Record<string, unknown>) => void;
}

export interface BlockToolbarButton {
  icon: IconName;
  title: string;
  active?: boolean;
  onClick: (ctx: BlockToolbarContext, button: HTMLButtonElement) => void;
}

export interface SlashEntry {
  label: string;
  keywords: string[];
  icon: string;
  /** Props the created block starts with, merged over the schema defaults. */
  props?: Record<string, unknown>;
  /**
   * Insert something other than a single block of this type — a table is a
   * subtree, a database needs a host record. Return the id to focus, or null
   * to decline (a host that provides no page store, say).
   */
  insert?: (view: EditorView, afterBlockId: BlockId) => BlockId | null;
  /** Hide the entry when the host cannot support it. */
  available?: (view: EditorView) => boolean;
}

export interface TurnIntoEntry {
  label: string;
  icon: string;
  props?: Record<string, unknown>;
}

/** Return true when the key was handled; the keymap then stops. */
export type BlockKeyHandler = (ctx: { view: EditorView; block: Block; event: KeyboardEvent }) => boolean;

export interface BlockView {
  /**
   * Replace the block's rendering entirely. For blocks that are not a row of
   * text — a table, an image, a database view, a column container.
   */
  render?: (ctx: BlockRenderContext, block: Block) => HTMLElement;
  /**
   * Prepend chrome to the standard row: a bullet, a number, a checkbox, a
   * toggle arrow, a callout's icon.
   *
   * Most blocks want this rather than `render`. Keeping the two apart is what
   * stops every text-shaped block from re-implementing the row-and-leaf walk,
   * which is how a plugin API accumulates copy-paste.
   */
  chrome?: (ctx: BlockRenderContext, block: Block) => HTMLElement | null;
  /** Entries for the ⋮⋮ gutter menu. */
  actions?: (ctx: BlockActionContext) => MenuEntry[];
  /** Buttons for the floating per-block toolbar. */
  toolbar?: (ctx: BlockToolbarContext) => BlockToolbarButton[];
  /**
   * How this block appears in the slash menu. Omit to keep it out; give an
   * array when one block type has presets worth offering separately — a
   * callout's info/warning/success variants are four entries, one type.
   */
  slash?: SlashEntry | SlashEntry[];
  /** How this block appears under "Turn into". Omit to keep it out. */
  turnInto?: TurnIntoEntry | TurnIntoEntry[];
  /**
   * Key handlers, by `KeyboardEvent.key`. Each may be ranked, because a block
   * can need to win the keyboard while losing another contribution.
   */
  keys?: Record<string, BlockKeyHandler | Ranked<BlockKeyHandler>>;
  /** This block's own CSS, injected once per document when it is registered. */
  styles?: string;
}

/** A plugin whose `view` has been refined to this layer's type. */
export interface DomBlockPlugin extends BlockPlugin {
  view?: BlockView;
}

export function viewOf(plugin: BlockPlugin | undefined): BlockView | undefined {
  return (plugin as DomBlockPlugin | undefined)?.view;
}

/**
 * Inject a plugin's styles once per document.
 *
 * Keyed by block type rather than by plugin identity, so two editors on one
 * page share one style element instead of appending a duplicate each — the
 * per-instance rule applies to *state*, and a stylesheet is not state.
 */
const injected = new Set<string>();

export function injectBlockStyles(type: string, css: string, root: Document = document): void {
  const key = `${type}`;
  if (injected.has(key)) return;
  injected.add(key);
  const style = root.createElement('style');
  style.dataset['nbeBlock'] = type;
  style.textContent = css;
  root.head.append(style);
}

/** Test seam: styles are document state, and tests must start from empty. */
export function __resetInjectedStyles(): void {
  injected.clear();
  for (const el of document.querySelectorAll('style[data-nbe-block]')) el.remove();
}
