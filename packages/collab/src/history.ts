import { LoroMap, type LoroDoc } from 'loro-crdt';
import type { Block } from '@nbe/core';
import type { LoroBlockStore } from './store';

/**
 * Document history — the past, and the way back to it.
 *
 * @remarks
 * **The log is the history; only the names are stored.** Loro already keeps an
 * ordered log of changes with timestamps, and a version is addressable as a set
 * of frontiers, so `list()` derives the timeline rather than duplicating it.
 *
 * The first attempt went further and stored nothing at all, using Loro's
 * per-change `message` as the checkpoint name. That does not work here, and the
 * reason is worth keeping: `LoroBlockStore.set` commits on every write, so by
 * the time a person names a version there is nothing pending for the message to
 * attach to. Naming is therefore its own small record — a name and the frontiers
 * it points at. That is not the same fact twice: the log holds *when* the
 * document changed, and this holds *what a person called* one of those moments,
 * which is nowhere in the log.
 *
 * **Restoring writes the past forward. It never rewinds.** A rewind is
 * unrepresentable in a shared document: other peers hold changes after the
 * point you want back, and discarding them locally does not discard them
 * anywhere else — the next sync would bring them straight back, or worse,
 * merge them into a document that no longer expects them. So restoring reads
 * the document as it was and applies it as a new edit on top. The consequences
 * are the right ones: the restore is itself in the history, it can be undone,
 * and a peer who was offline converges rather than fighting.
 *
 * **Distinct from undo.** Undo is per-session and per-user, over the op log in
 * `core`. This is the document's history, shared by everyone who has it.
 *
 * @category Collaboration
 */

/** A point in the document's past. */
export interface Revision {
  /**
   * The version, as Loro addresses it.
   *
   * @remarks
   * A change spans `[counter, counter + length)`, so the version *after* it has
   * run is `counter + length - 1`. Getting that off by one silently returns the
   * document as it was one operation earlier, which looks like a bug in the
   * editor rather than in the arithmetic.
   */
  frontiers: Array<{ peer: `${number}`; counter: number }>;
  /** The checkpoint's name, when this change was one. */
  message?: string;
  /** Epoch milliseconds. Loro records seconds; this is normalised. */
  at: number;
  /** How many operations this change carries. */
  length: number;
}

/** The root container holding checkpoint names. */
const ROOT = 'checkpoints';

export class LoroHistory {
  private readonly names: LoroMap;

  constructor(
    private readonly store: LoroBlockStore,
    private readonly doc: LoroDoc = store.doc,
  ) {
    this.names = doc.getMap(ROOT);
    /*
     * Off by default in Loro, because a timestamp per change costs space that a
     * pure CRDT does not need. A history a person reads is exactly the case
     * that does need it — "just now" and "last Tuesday" is most of what makes
     * a version list usable.
     */
    this.doc.setRecordTimestamp(true);
  }

  /**
   * Name the current state.
   *
   * @param name - What this version is, in the user's words.
   *
   * @remarks
   * Commits whatever is pending under that message. If nothing is pending there
   * is no change to attach it to, and the checkpoint is silently the previous
   * one — which is correct: naming an identical state twice describes one
   * state.
   */
  checkpoint(name: string, at: number = Date.now()): void {
    const frontiers = this.doc.frontiers().map((f) => ({ peer: f.peer, counter: f.counter }));
    const entry = this.names.setContainer(`${at}-${frontiers[0]?.counter ?? 0}`, new LoroMap());
    entry.set('name', name);
    entry.set('at', at);
    entry.set('frontiers', JSON.stringify(frontiers));
    this.doc.commit();
  }

  /** Every revision, newest first. */
  list(): Revision[] {
    const out: Revision[] = [];
    for (const [peer, changes] of this.doc.getAllChanges()) {
      for (const change of changes) {
        out.push({
          // the version *after* this change, not the one it started from
          frontiers: [{ peer: peer as `${number}`, counter: change.counter + change.length - 1 }],
          ...(change.message ? { message: change.message } : {}),
          at: (change.timestamp ?? 0) * 1000,
          length: change.length,
        });
      }
    }
    return out.sort((a, b) => b.at - a.at || b.frontiers[0]!.counter - a.frontiers[0]!.counter);
  }

  /** The versions someone named, newest first. */
  checkpoints(): Revision[] {
    const out: Revision[] = [];
    for (const key of this.names.keys()) {
      const entry = this.names.get(key);
      if (!(entry instanceof LoroMap)) continue;
      try {
        out.push({
          frontiers: JSON.parse(String(entry.get('frontiers') ?? '[]')) as Revision['frontiers'],
          message: String(entry.get('name') ?? ''),
          at: Number(entry.get('at') ?? 0),
          length: 0,
        });
      } catch {
        // a name we cannot read is one checkpoint lost, not a broken timeline
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * The document as it was.
   *
   * @remarks
   * Checks out, reads, and comes straight back in one synchronous stretch — the
   * document must never be left detached, because an edit arriving while it is
   * would be written into the past. The store's id index is derived from the
   * tree, so it is rebuilt on both legs of the trip.
   */
  readAt(frontiers: Revision['frontiers']): Block[] {
    this.doc.checkout(frontiers);
    try {
      this.store.reindex();
      return [...this.store.values()];
    } finally {
      this.doc.checkoutToLatest();
      this.store.reindex();
    }
  }

  /**
   * Bring a past version back, as a new edit.
   *
   * @remarks
   * Blocks that existed then are written; blocks that did not are removed. The
   * removal runs first so a block that moved between parents is not briefly
   * present twice, and the writes then re-establish order.
   */
  restore(frontiers: Revision['frontiers'], name?: string): void {
    const past = this.readAt(frontiers);
    const wanted = new Map(past.map((block) => [block.id, block]));

    for (const block of [...this.store.values()]) {
      if (!wanted.has(block.id)) this.store.delete(block.id);
    }
    for (const block of past) this.store.set(block.id, block);

    // the restore is itself a version, and deserves to be findable
    this.checkpoint(name ?? 'Version restaurée');
  }
}
