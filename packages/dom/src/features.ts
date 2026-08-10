import type { EditorView } from './view';
import { attachInput } from './input';
import { attachKeymap } from './keymap';
import { attachSelectionSync } from './selection';
import { attachSlashMenu } from './slash';
import { attachMentions } from './mention';
import { attachCrossBlockHighlight } from './cross-block-highlight';
import { attachViewportGuard } from './viewport';
import { attachControls } from './controls';
import { attachClipboard } from './clipboard';
import { attachGestureRouter } from './gestures';
import { attachOutsidePressDeselect } from './caret';
import { attachDatabaseBlocks } from './database';
import { attachSelectionToolbar } from './selection-toolbar';
import { attachBlockToolbar } from './block-toolbar';
import { attachLinkHover } from './link-hover';
import { attachCommentMarkers } from './comment-marker';
import { mediaResizeFeature } from './media-resize';
import { attachFind } from './search';
export { mediaResizeFeature } from './media-resize';
export { wordCountFeature } from './word-count';

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
/** Paints a text selection that spans blocks, which the browser will not hold. */
export const crossBlockHighlightFeature = feature('cross-block-highlight', attachCrossBlockHighlight);
/** Keeps the caret visible when a virtual keyboard opens over it. */
export const viewportGuardFeature = feature('viewport-guard', attachViewportGuard);
/** Pointer arbitration: text selection, block click-routing, the rubber band. */
export const gesturesFeature = feature('gestures', attachGestureRouter);
/** Drops a block selection when a press lands outside the editor. */
export const outsidePressFeature = feature('outside-press', attachOutsidePressDeselect);
/** A commented block says so in the right margin, without being hovered. */
export const commentMarkersFeature = feature('comment-markers', attachCommentMarkers);
/**
 * `⌘F` finds in the page. **Not in {@link defaultFeatures}**, deliberately: in
 * a browser that key is the browser's, and replacing it with something worse
 * is one of the things this project's competitors are resented for. Add it in
 * a host that has no browser find to take — a plugin pane, a desktop shell.
 */
export const findFeature = feature('find', attachFind);
export { exportFeature } from './export';
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
/**
 * The same toolbar, pinned above the document instead — the older WYSIWYG
 * shape, always visible.
 *
 * @remarks
 * **Not in {@link defaultFeatures}**, and mutually exclusive with
 * {@link formatToolbarFeature} in practice: two bars offering the same seven
 * marks, one of them floating over the other, is not a configuration anyone
 * meant to choose. Swap it in rather than adding it:
 *
 * ```ts
 * features: defaultFeatures.map((f) => (f.name === 'format-toolbar' ? stickyFormatToolbarFeature : f))
 * ```
 */
export const stickyFormatToolbarFeature = feature('sticky-format-toolbar', (view) =>
  attachSelectionToolbar(view, { sticky: true }),
);
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
  crossBlockHighlightFeature,
  viewportGuardFeature,
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
  commentMarkersFeature,
  mediaResizeFeature,
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
  crossBlockHighlightFeature,
  viewportGuardFeature,
  gesturesFeature,
  clipboardFeature,
];

/**
 * The older kind of editor: a page of text with a toolbar, no block chrome.
 *
 * @remarks
 * There is no such thing as turning the blocks *off* — the document is blocks,
 * that is the whole architecture, and a "classic mode" that changed the model
 * would be a second editor sharing a name. What can be turned off is every
 * affordance that makes the blocks *visible*: the hover gutter and its handle,
 * the ⋮⋮ menu, the slash menu, the `@` picker, the per-block toolbar, the drag
 * and the edge handles. What is left is a page you type into, with a bar over
 * it — which is what anyone asking for a classic editor is asking for.
 *
 * Pair it with `topology: singleHostTopology`, and that pairing is the point
 * rather than a detail: the default puts one editing host per block, which is
 * correct and invisible until you look at the DOM — under the single-host
 * topology the whole document is one `contenteditable`, which is what a classic
 * editor *is*, and what makes a browser's own native selection behave the way
 * someone coming from one expects.
 *
 * What you still get, because none of it is block chrome: every keyboard
 * shortcut, the Markdown autoformat, the clipboard's three formats, the link
 * card, IME safety, undo.
 *
 * @example
 * ```ts
 * import { classicFeatures, singleHostTopology } from '@nbe/dom'
 * new EditorView(el, editor, { features: classicFeatures, topology: singleHostTopology })
 * ```
 *
 * @category Configuration
 */
export const classicFeatures: EditorFeature[] = [
  inputFeature,
  keymapFeature,
  selectionSyncFeature,
  crossBlockHighlightFeature,
  viewportGuardFeature,
  gesturesFeature,
  clipboardFeature,
  linkHoverFeature,
  stickyFormatToolbarFeature,
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
