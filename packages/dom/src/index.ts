/**
 * The single contenteditable view: rendering, keymaps, clipboard, drag,
 * overlays and the UI primitives.
 *
 * @module @nbe/dom
 */

export { EditorView } from './view';
export type { EditorViewOptions, CommentAuthor } from './view';
export { defaultLeftGutter, defaultRightGutter } from './controls';
export type { GutterAction, GutterItem } from './controls';
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
export { builtinBlocks } from './blocks';
export { blockActionEntries, registerBlockActions } from './block-actions';
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
  viewportGuardFeature,
  slashMenuFeature,
  mentionsFeature,
  gutterFeature,
  clipboardFeature,
  formatToolbarFeature,
  blockToolbarFeature,
  linkHoverFeature,
  databaseFeature,
  commentMarkersFeature,
  findFeature,
} from './features';
export type { EditorFeature } from './features';
export { attachCrossBlockHighlight, canPaintCrossBlock } from './cross-block-highlight';
export { attachRemoteCarets, peerSelection, type RemotePeer, type RemoteSelection } from './remote-carets';
export { attachViewportGuard, reveal } from './viewport';
export { attachFind, findHits } from './search';
export { attachMentions, mentionRuns, MENTION_MARK } from './mention';
export type { MentionCandidate } from './mention';
export { attachTriggerMenu } from './trigger-menu';
export type { TriggerMenuOptions } from './trigger-menu';
export { format, defaultLabels, resolveLabels } from './labels';
export type { EditorLabels } from './labels';
