/**
 * The single contenteditable view: rendering, keymaps, clipboard, drag,
 * overlays and the UI primitives.
 *
 * @module @nbe/dom
 */

export { EditorView } from './view';
export type { EditorViewOptions, CommentAuthor, CommentContext, SlotName } from './view';
export { defaultLeftGutter, defaultRightGutter } from './controls';
export type { GutterAction, GutterItem } from './controls';
export { openCommentThread, removeCommentThread } from './comment-thread';
export type { CommentThreadOptions } from './comment-thread';
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
  stickyFormatToolbarFeature,
  classicFeatures,
  blockToolbarFeature,
  linkHoverFeature,
  databaseFeature,
  commentMarkersFeature,
  findFeature,
  mediaResizeFeature,
} from './features';
export type { EditorFeature } from './features';
export { attachCrossBlockHighlight, canPaintCrossBlock } from './cross-block-highlight';
export {
  attachRemoteCarets,
  peerSelection,
  type FollowControl,
  type RemotePeer,
  type RemoteSelection,
} from './remote-carets';
export { attachViewportGuard, reveal, REVEAL_MARGIN } from './viewport';
export { caretLine, isMod, shortcut } from './keymap';
export { attachFind, findHits, openFind } from './search';
export { insertBlocksAt } from './clipboard';
export { refreshCommentMarkers } from './comment-marker';
export { wordCountFeature, documentSize } from './word-count';
export type { DocumentSize } from './word-count';
export {
  createExport,
  exportFeature,
  openExport,
  defaultExportFormats,
  markdownFormat,
  textFormat,
  printFormat,
} from './export';
export type { ExportFormat } from './export';
export { openPagePicker, openPagePickerOn } from './page-picker';
export { offerLinkTreatments, loneLink } from './link-paste';
export { resizeHandles, requestFullscreen, DEFAULT_ALIGN } from './media-resize';
export { TYPEFACES } from './typography';
export type { Typeface } from './typography';
export { debugFeature, debugHolding } from './debug';
export type { LinkPasteOptions } from './link-paste';
export { attachMentions, mentionRuns, MENTION_MARK } from './mention';
export type { MentionCandidate } from './mention';
export { attachTriggerMenu } from './trigger-menu';
export type { TriggerMenuOptions } from './trigger-menu';
export { format, defaultLabels, resolveLabels } from './labels';
export { LOCALES, LOCALE_NAMES, labelsFor, en, fr, es, it, de } from './i18n';
export type { LocaleCode } from './i18n';
export type { EditorLabels } from './labels';
