import { uuidv7 } from './id';
import type { Doc } from './doc';
import type { Block, BlockId } from './types';

/**
 * Comment threads, anchored to text rather than to positions.
 *
 * @remarks
 * **The anchor is a mark.** A comment covers a range of text, and §2.2 forbids
 * persisting integer offsets — they are exactly what stops meaning anything
 * the moment someone types above them. So commenting a selection applies a
 * `comment` mark carrying the thread's id, using the `format_text` op that
 * already exists: no new operation, no second anchoring mechanism, and the
 * anchor moves with its text through every edit and every merge because that
 * is what marks already do.
 *
 * It also settles the hardest case for free. Under a CRDT, two people editing
 * around a comment converge on where the marked characters ended up; had the
 * anchor been an offset, they would converge on a document and disagree about
 * what the comment referred to.
 *
 * **Threads are not blocks.** The tempting shortcut is a `comment_thread`
 * block, which would inherit sync and persistence at no cost. It also inherits
 * the Markdown projection: an unrecognised block type exports as an
 * `<!-- nbe:… -->` marker, so every thread would show up in the vault the L1
 * format exists to keep readable. Threads live beside the document instead.
 *
 * **Text can outlive its comment, and a comment its text.** Deleting the
 * commented words removes the mark but not the thread — the discussion is
 * still worth reading, and silently dropping it loses the only record of why
 * something changed. {@link orphanThreads} finds those so a UI can show them
 * apart rather than pretending they still point somewhere.
 *
 * @category Comments
 */

/** One message in a thread. */
export interface CommentMessage {
  id: string;
  /** Who wrote it — a peer or account id, not a display name. */
  author: string;
  /** The name to show, captured at write time so it survives the author. */
  authorName?: string;
  /** Plain text. Rich text in a comment is a want, not a need. */
  body: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface CommentThread {
  id: string;
  messages: CommentMessage[];
  resolved: boolean;
  /**
   * The block the anchor was in when the thread was created.
   *
   * @remarks
   * A hint for ordering threads down the page and for showing an orphan near
   * where it used to be. Never the anchor itself: the mark is. It is allowed
   * to be stale, and nothing may resolve a thread's position from it.
   */
  blockId?: BlockId;
}

export interface CommentStore {
  list(): CommentThread[];
  get(id: string): CommentThread | undefined;
  create(thread: CommentThread): void;
  addMessage(threadId: string, message: CommentMessage): void;
  /**
   * Remove one message.
   *
   * @remarks
   * A comment *is* a message — "delete this comment" has to be able to mean
   * the reply you just mistyped, not the whole discussion around it. The last
   * message takes its thread with it: an empty thread is a card nobody can
   * read and nobody can get rid of, and both stores agree on that here rather
   * than in whichever UI remembers to check.
   */
  deleteMessage(threadId: string, messageId: string): void;
  setResolved(threadId: string, resolved: boolean): void;
  delete(threadId: string): void;
  /** Fires on every change. Returns an unsubscribe. */
  onChange(handler: () => void): () => void;
}

/** Build a message, filling in the parts a caller should not have to. */
export function newMessage(author: string, body: string, authorName?: string): CommentMessage {
  return { id: uuidv7(), author, body, at: Date.now(), ...(authorName ? { authorName } : {}) };
}

/** Build a thread from its first message. */
export function newThread(first: CommentMessage, blockId?: BlockId): CommentThread {
  return { id: uuidv7(), messages: [first], resolved: false, ...(blockId ? { blockId } : {}) };
}

/**
 * A store held in memory.
 *
 * @remarks
 * What a single-player document uses, and what the Loro-backed one is checked
 * against. Threads are kept in insertion order; uuidv7 ids sort by time, so a
 * caller wanting chronological order can sort by id without a timestamp.
 */
export function memoryComments(initial: CommentThread[] = []): CommentStore {
  const threads = new Map(initial.map((thread) => [thread.id, thread]));
  const handlers = new Set<() => void>();
  const notify = (): void => {
    for (const handler of handlers) handler();
  };

  return {
    list: () => [...threads.values()],
    get: (id) => threads.get(id),
    create(thread) {
      threads.set(thread.id, thread);
      notify();
    },
    addMessage(threadId, message) {
      const thread = threads.get(threadId);
      if (!thread) return;
      // replace rather than push: a store that hands out copies must see a write
      threads.set(threadId, { ...thread, messages: [...thread.messages, message] });
      notify();
    },
    deleteMessage(threadId, messageId) {
      const thread = threads.get(threadId);
      if (!thread) return;
      const messages = thread.messages.filter((message) => message.id !== messageId);
      if (messages.length === thread.messages.length) return; // no such message: no change, no notify
      if (messages.length) threads.set(threadId, { ...thread, messages });
      else threads.delete(threadId);
      notify();
    },
    setResolved(threadId, resolved) {
      const thread = threads.get(threadId);
      if (!thread) return;
      threads.set(threadId, { ...thread, resolved });
      notify();
    },
    delete(threadId) {
      if (threads.delete(threadId)) notify();
    },
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/** The thread ids a block's text is marked with. */
export function threadIdsIn(block: Block): string[] {
  const found = new Set<string>();
  for (const run of block.text ?? []) {
    for (const mark of run.marks ?? []) {
      if (mark.type !== 'comment') continue;
      const id = mark.attrs?.['threadId'];
      if (typeof id === 'string') found.add(id);
    }
  }
  return [...found];
}

/** Every thread id anchored anywhere in the document, and where. */
export function anchoredThreads(doc: Doc): Map<string, BlockId> {
  const anchors = new Map<string, BlockId>();
  for (const block of doc.blocks.values()) {
    for (const id of threadIdsIn(block)) {
      if (!anchors.has(id)) anchors.set(id, block.id);
    }
  }
  return anchors;
}

/**
 * Threads whose text is gone.
 *
 * @remarks
 * Not an error and not something to clean up automatically: a comment on a
 * sentence that was rewritten is often the reason it was rewritten. A UI shows
 * these somewhere they can still be read and resolved.
 */
export function orphanThreads(doc: Doc, store: CommentStore): CommentThread[] {
  const anchored = anchoredThreads(doc);
  return store.list().filter((thread) => !anchored.has(thread.id));
}

/**
 * Threads in the order their anchors appear down the page.
 *
 * @param order - The block ids in document order, as the caller already has
 * them from rendering. Passed in rather than recomputed, because the document
 * tree is the renderer's business and walking it twice invites the two walks
 * to disagree.
 */
export function threadsInDocumentOrder(doc: Doc, store: CommentStore, order: readonly BlockId[]): CommentThread[] {
  const anchored = anchoredThreads(doc);
  const rank = new Map(order.map((id, index) => [id, index]));
  return store
    .list()
    .filter((thread) => anchored.has(thread.id))
    .sort((a, b) => {
      const left = rank.get(anchored.get(a.id)!) ?? Number.MAX_SAFE_INTEGER;
      const right = rank.get(anchored.get(b.id)!) ?? Number.MAX_SAFE_INTEGER;
      // same block: fall back to creation order, which uuidv7 encodes
      return left === right ? (a.id < b.id ? -1 : 1) : left - right;
    });
}
