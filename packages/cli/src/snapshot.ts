import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoroBlockStore } from '@nbe/collab';

/**
 * A document on disk, for the two processes that keep one.
 *
 * @remarks
 * `nbe serve` holds a room because it is the relay; `nbe peer` holds one
 * because it dialled a relay someone else runs. The storage question is the
 * same for both and was written twice before this file existed.
 *
 * **Snapshots, not a log.** Each room is one Loro snapshot, replaced atomically:
 * the write goes to a temporary name and is renamed over the target, because
 * rename is the only filesystem operation that is atomic on every platform we
 * care about, and a NAS is exactly where a half-written file survives to be
 * read back later.
 *
 * @category CLI
 */

/**
 * A room name as a filename.
 *
 * @remarks
 * Percent-encoding rather than a slug: a room name is an identifier chosen by
 * a client, not a title shown to anyone, so it must round-trip exactly and two
 * different rooms must never land on one file. `encodeURIComponent` escapes
 * `/` and every separator, and is reversible — a slug is neither.
 */
export function fileFor(dir: string, room: string): string {
  return join(dir, `${encodeURIComponent(room)}.loro`);
}

/**
 * Read a snapshot into a store, if there is one.
 *
 * @returns Whether anything was loaded. A snapshot we cannot read is reported
 * and left in place rather than deleted — it is the only evidence of what broke
 * — and the caller starts empty, which a local-first design survives: the first
 * peer to connect still holds the document.
 */
export function loadSnapshot(store: LoroBlockStore, path: string, onError: (error: unknown) => void): boolean {
  if (!existsSync(path)) return false;
  try {
    store.import(readFileSync(path));
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export interface PersistOptions {
  /**
   * How long to wait after a change before writing.
   *
   * @remarks
   * Typing produces a change per keystroke and a snapshot is the whole
   * document, so writing on every one would turn a sentence into a hundred
   * whole-file writes. Coalescing is what makes this affordable on a spinning
   * disk; the cost of the delay is bounded by the flush on stop.
   */
  debounceMs?: number;
  onSave?: (bytes: number) => void;
  onError: (error: unknown) => void;
}

/**
 * Write the store to `path` whenever it changes, debounced.
 *
 * @returns A function that stops watching and flushes what is pending, so the
 * last keystroke before a shutdown is not the one that is lost.
 */
export function persistSnapshot(store: LoroBlockStore, path: string, opts: PersistOptions): () => void {
  mkdirSync(dirname(path), { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = (): void => {
    timer = undefined;
    try {
      const bytes = store.doc.export({ mode: 'snapshot' });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, bytes);
      renameSync(temporary, path);
      opts.onSave?.(bytes.length);
    } catch (error) {
      opts.onError(error);
    }
  };

  const unsubscribe = store.doc.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, opts.debounceMs ?? 400);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    save();
  };
}
