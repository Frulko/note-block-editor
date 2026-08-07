import type { EditorView } from './view';
import { attachInput } from './input';
import { attachKeymap } from './keymap';
import { attachSelectionSync } from './selection';
import { attachSlashMenu } from './slash';
import { attachMentions } from './mention';
import { attachControls } from './controls';
import { attachClipboard } from './clipboard';
import { attachGestureRouter } from './gestures';
import { attachOutsidePressDeselect } from './caret';
import { attachDatabaseBlocks } from './database';
import { attachSelectionToolbar } from './selection-toolbar';
import { attachBlockToolbar } from './block-toolbar';
import { attachLinkHover } from './link-hover';

/**
 * A feature is anything that attaches behaviour to a mounted view and can be
 * removed again.
 *
 * @remarks
 * The signature was already this shape — twelve `attach*(view)` calls
 * hardwired in the constructor, each returning its own unbind. Turning that
 * array into an option is most of the work of making the editor composable,
 * and it means an editor that does not want the slash menu does not ship it.
 *
 * Order is registration order. There is deliberately no priority system:
 * features attach independent listeners, and the two places precedence
 * genuinely matters — pointer gestures and overlay dismissal — already have
 * their own explicit models.
 *
 * @category Configuration
 */
export interface EditorFeature {
  name: string;
  attach: (view: EditorView) => () => void;
}

const feature = (name: string, attach: (view: EditorView) => () => void): EditorFeature => ({ name, attach });

/** Reading and writing text: beforeinput, composition, the DOM reconciler. */
export const inputFeature = feature('input', attachInput);
/** Keyboard commands and navigation. */
export const keymapFeature = feature('keymap', attachKeymap);
/** Mirrors the browser selection into the model. */
export const selectionSyncFeature = feature('selection-sync', attachSelectionSync);
/** Pointer arbitration: text selection, block click-routing, the rubber band. */
export const gesturesFeature = feature('gestures', attachGestureRouter);
/** Drops a block selection when a press lands outside the editor. */
export const outsidePressFeature = feature('outside-press', attachOutsidePressDeselect);
/** `/` opens the block menu. */
export const slashMenuFeature = feature('slash-menu', attachSlashMenu);
/** `@` opens the page-mention picker. Inert without an `onSearchPages` host. */
export const mentionsFeature = feature('mentions', attachMentions);
/** The hover gutter: the + button, the ⋮⋮ handle, its menu, and drag & drop. */
export const gutterFeature = feature('gutter', attachControls);
/** Copy, cut and the full paste pipeline. */
export const clipboardFeature = feature('clipboard', attachClipboard);
/** The floating format toolbar shown over a text selection. */
export const formatToolbarFeature = feature('format-toolbar', attachSelectionToolbar);
/** The per-block toolbar shown on hover. */
export const blockToolbarFeature = feature('block-toolbar', attachBlockToolbar);
/** The hover card on a link, for editing or opening it. */
export const linkHoverFeature = feature('link-hover', attachLinkHover);
/** Interactive database views. Needs a `database` host to do anything. */
export const databaseFeature = feature('database', attachDatabaseBlocks);

/**
 * Everything that makes the editor feel like the demo.
 *
 * @remarks
 * A plain array literal, not a barrel that imports everything and disables at
 * runtime — the same reason `builtinBlocks` is empty. Copy it, remove what you
 * do not want, and what you removed is not in your bundle.
 *
 * @example
 * ```ts
 * import { defaultFeatures } from '@nbe/dom'
 * new EditorView(el, editor, {
 *   features: defaultFeatures.filter((f) => f.name !== 'slash-menu'),
 * })
 * ```
 *
 * @category Configuration
 */
export const defaultFeatures: EditorFeature[] = [
  inputFeature,
  keymapFeature,
  selectionSyncFeature,
  gesturesFeature,
  outsidePressFeature,
  slashMenuFeature,
  mentionsFeature,
  gutterFeature,
  clipboardFeature,
  formatToolbarFeature,
  blockToolbarFeature,
  linkHoverFeature,
  databaseFeature,
];

/**
 * The smallest editor that still edits: type, navigate, select, paste.
 *
 * @remarks
 * No chrome at all — no gutter, no toolbars, no slash menu. Useful for a
 * comment box or a single-line title field, and as the honest floor of what
 * "an editor" means here.
 *
 * @category Configuration
 */
export const minimalFeatures: EditorFeature[] = [
  inputFeature,
  keymapFeature,
  selectionSyncFeature,
  gesturesFeature,
  clipboardFeature,
];

/**
 * Nothing attached: the document renders and never changes.
 *
 * @remarks
 * Pair with `readOnly: true`, which also drops `contenteditable` so the caret
 * never appears. Features alone would leave a focusable, caret-bearing surface
 * that silently ignores every keystroke.
 *
 * @category Configuration
 */
export const readOnlyFeatures: EditorFeature[] = [];
