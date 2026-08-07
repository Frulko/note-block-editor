import { LoroList, LoroMap, type LoroDoc } from 'loro-crdt';
import type { CommentMessage, CommentStore, CommentThread } from '@nbe/core';

/**
 * Comment threads that merge, in the same document as the blocks.
 *
 * @remarks
 * `core` defines the model and an in-memory store; this is the one that syncs.
 * It lives in a **root container beside the block tree** rather than in a
 * document of its own, which is the whole trick: one `LoroDoc` means one
 * `connect()`, one snapshot, one version vector. Comments arrive with the text
 * they annotate, and there is no second sync path that could be a version
 * behind — nothing here touches the wire protocol at all.
 *
 * **Messages are a list of containers, not an array value.** Stored as a value,
 * two people replying at the same moment produce two whole-array writes and one
 * of the replies is gone; as a `LoroList` of `LoroMap`s they merge, and both
 * peers agree on the order. That was checked by running it, not by reading
 * about it — the same discipline the block store's text handling came from.
 *
 * **Notifications are filtered by container.** A comment panel subscribed to
 * the raw document would re-render on every keystroke in the page, since the
 * blocks share this document. Loro's change events carry the path, whose first
 * element is the root container's name, so the filter is exact rather than a
 * guess.
 *
 * @category Comments
 */

/** The root container. One name, used by both ends. */
const ROOT = 'comments';

/** A thread's fields, as they are stored. `messages` is a container. */
interface StoredThread {
  id: string;
  resolved: boolean;
  blockId?: string;
}

export class LoroComments implements CommentStore {
  private readonly threads: LoroMap;

  constructor(readonly doc: LoroDoc) {
    this.threads = doc.getMap(ROOT);
  }

  private mapOf(threadId: string): LoroMap | undefined {
    const value = this.threads.get(threadId);
    return value instanceof LoroMap ? value : undefined;
  }

  /** A thread's messages, created on first use. */
  private messagesOf(map: LoroMap): LoroList {
    const existing = map.get('messages');
    if (existing instanceof LoroList) return existing;
    return map.setContainer('messages', new LoroList());
  }

  private toThread(map: LoroMap): CommentThread {
    const blockId = map.get('blockId');
    return {
      id: String(map.get('id') ?? ''),
      resolved: map.get('resolved') === true,
      messages: this.messagesOf(map)
        .toArray()
        .filter((entry): entry is LoroMap => entry instanceof LoroMap)
        .map((entry) => ({
          id: String(entry.get('id') ?? ''),
          author: String(entry.get('author') ?? ''),
          body: String(entry.get('body') ?? ''),
          at: Number(entry.get('at') ?? 0),
          ...(entry.get('authorName') ? { authorName: String(entry.get('authorName')) } : {}),
        })),
      ...(typeof blockId === 'string' ? { blockId } : {}),
    };
  }

  list(): CommentThread[] {
    const out: CommentThread[] = [];
    for (const key of this.threads.keys()) {
      const map = this.mapOf(key);
      if (map) out.push(this.toThread(map));
    }
    // uuidv7 ids sort by creation time, so this is chronological
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  get(id: string): CommentThread | undefined {
    const map = this.mapOf(id);
    return map ? this.toThread(map) : undefined;
  }

  create(thread: CommentThread): void {
    const map = this.mapOf(thread.id) ?? this.threads.setContainer(thread.id, new LoroMap());
    const stored: StoredThread = {
      id: thread.id,
      resolved: thread.resolved,
      ...(thread.blockId ? { blockId: thread.blockId } : {}),
    };
    for (const [key, value] of Object.entries(stored)) map.set(key, value as never);
    const messages = this.messagesOf(map);
    for (const message of thread.messages) this.push(messages, message);
    this.doc.commit();
  }

  private push(messages: LoroList, message: CommentMessage): void {
    const entry = messages.insertContainer(messages.length, new LoroMap());
    entry.set('id', message.id);
    entry.set('author', message.author);
    entry.set('body', message.body);
    entry.set('at', message.at);
    if (message.authorName) entry.set('authorName', message.authorName);
  }

  addMessage(threadId: string, message: CommentMessage): void {
    const map = this.mapOf(threadId);
    if (!map) return;
    this.push(this.messagesOf(map), message);
    this.doc.commit();
  }

  setResolved(threadId: string, resolved: boolean): void {
    const map = this.mapOf(threadId);
    if (!map) return;
    map.set('resolved', resolved);
    this.doc.commit();
  }

  delete(threadId: string): void {
    if (!this.mapOf(threadId)) return;
    this.threads.delete(threadId);
    this.doc.commit();
  }

  onChange(handler: () => void): () => void {
    return this.doc.subscribe((event) => {
      // only our container: the blocks share this document, and a panel that
      // re-rendered on every keystroke would be this file's fault
      if (event.events.some((one) => one.path[0] === ROOT)) handler();
    });
  }
}
