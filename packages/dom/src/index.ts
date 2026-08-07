/**
 * The single contenteditable view: rendering, keymaps, clipboard, drag,
 * overlays and the UI primitives.
 *
 * @module @nbe/dom
 */

export { EditorView } from './view';
export type { EditorViewOptions } from './view';
export { renderBlock } from './render';
export { domToModelPoint, modelPointToDom } from './selection';
export { perBlockTopology, singleHostTopology, leafOf, nativeRangeSpans } from './topology';
export type { EditableTopology } from './topology';
export { attachGestureRouter } from './gestures';
export type { GestureRecognizer, GestureSession, PressContext, ActiveGesture } from './gestures';
export { defaultRecognizers, textSelectRecognizer, blockClickRecognizer, rubberBandRecognizer } from './recognizers';
export * from './ui';
export { renderDatabase } from './database';
export type { DatabaseHost, DatabaseData } from './database';
export { viewOf, injectBlockStyles } from './block-view';
export type {
  BlockView,
  DomBlockPlugin,
  BlockRenderContext,
  BlockActionContext,
  BlockToolbarContext,
  BlockToolbarButton,
  SlashEntry,
  TurnIntoEntry,
  BlockKeyHandler,
} from './block-view';
export {
  defaultFeatures,
  minimalFeatures,
  readOnlyFeatures,
  inputFeature,
  keymapFeature,
  selectionSyncFeature,
  gesturesFeature,
  outsidePressFeature,
  crossBlockHighlightFeature,
  slashMenuFeature,
  mentionsFeature,
  gutterFeature,
  clipboardFeature,
  formatToolbarFeature,
  blockToolbarFeature,
  linkHoverFeature,
  databaseFeature,
} from './features';
export type { EditorFeature } from './features';
export { attachCrossBlockHighlight, canPaintCrossBlock } from './cross-block-highlight';
export { attachMentions, mentionRuns, MENTION_MARK } from './mention';
export type { MentionCandidate } from './mention';
export { attachTriggerMenu } from './trigger-menu';
export type { TriggerMenuOptions } from './trigger-menu';
export { defaultLabels, resolveLabels } from './labels';
export type { EditorLabels } from './labels';
