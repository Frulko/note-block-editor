/**
 * The headless editor: block store, seven invertible operations,
 * transactions, selection, history and commands. Zero DOM.
 *
 * @module @nbe/core
 */

export * from './types';
export * from './id';
export * from './richtext';
export * from './schema';
export * from './doc';
export * from './ops';
export * from './editor';
export * from './commands';
export * from './db';
export * from './formula';
export * from './table';
export * from './migrate';
export * from './validate';
export * from './plugin';
export type { BlockStore } from './doc';
export { singleBlockRange } from './commands';
export {
  GRAPHEME_AWARE,
  graphemeBoundaries,
  graphemeLength,
  nextGrapheme,
  prevGrapheme,
  snapGrapheme,
} from './grapheme';
export { MARKS, expandsForward, markExpansion, registerMark, type MarkExpansion, type MarkSpec } from './marks';
export { documentOrder } from './doc';
export {
  anchoredThreads,
  memoryComments,
  newMessage,
  newThread,
  orphanThreads,
  threadIdsIn,
  threadsInDocumentOrder,
  type CommentMessage,
  type CommentStore,
  type CommentThread,
} from './comments';
