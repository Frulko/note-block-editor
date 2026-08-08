import { mkdirSync } from 'node:fs';
import { LoroBlockStore, connect } from '@nbe/collab';
import { startRelay, type Relay, type RelayOptions, type RoomTransport } from './relay';
import { fileFor, loadSnapshot, persistSnapshot } from './snapshot';

/**
 * A headless node: the peer that is always there.
 *
 * @remarks
 * The relay deliberately holds nothing — "a peer joining an empty room gets
 * nothing", because the document lives on the peers. That is right for a
 * local-first design and useless for the case this exists to serve: a NAS or a
 * small server that keeps everyone in sync when no two people are online at the
 * same moment.
 *
 * **It is a peer, not a smarter relay.** The temptation is to teach the relay
 * about documents so it can store them. That would cost the property the relay
 * was built around — a relay that cannot understand the data cannot corrupt it,
 * and never needs upgrading when the format changes. So instead the node joins
 * each room as an ordinary participant running the same `connect()` every
 * client runs, over a transport that happens to be in-process. The sync
 * protocol, the version vectors and the reconciliation are not reimplemented
 * here; there is no second implementation to keep in step.
 *
 * What that buys, concretely: a client opening a room the node already knows
 * sends its `Have`, the node answers with exactly what is missing, and the
 * document appears — the same exchange as between two laptops, with one of the
 * laptops never closing.
 *
 * **Snapshots, not a log.** Each room is written as one Loro snapshot, replaced
 * atomically. A NAS is exactly where a half-written file survives to be read
 * back later, so the write goes to a temporary name and is renamed over the
 * target — rename is the only filesystem operation that is atomic on every
 * platform we care about.
 *
 * **The node never edits.** It imports and it stores. That is what keeps it
 * safe to run unattended: it has no opinion that could be wrong, and a bug here
 * can lose availability but not content, since every client still holds the
 * document.
 *
 * @category Collaboration
 */

export interface NodeOptions extends Omit<RelayOptions, 'onRoomOpen'> {
  /** Where room snapshots live. Created if missing. */
  dir: string;
  /**
   * How long to wait after a change before writing.
   *
   * @remarks
   * Typing produces a change per keystroke and a snapshot is the whole
   * document, so writing on every one would turn a sentence into a hundred
   * whole-file writes. Coalescing is what makes this affordable on a spinning
   * disk; the cost of the delay is bounded by the flush on the room emptying.
   */
  saveDebounceMs?: number;
  /** Called after each successful write, for logging. */
  onSave?: (room: string, bytes: number) => void;
  /** A write failed. Default: log it — silence would hide a full disk. */
  onError?: (room: string, error: unknown) => void;
}

/**
 * Start a relay that also keeps every room's document.
 *
 * @param opts - {@link NodeOptions}. `dir` is required; everything else has a
 * working default.
 * @returns The relay, so a caller can read its port and close it.
 *
 * @example
 * ```ts
 * const node = await startNode({ port: 8787, dir: '/volume1/nbe' })
 * ```
 */
export function startNode(opts: NodeOptions): Promise<Relay> {
  const { dir, saveDebounceMs = 400 } = opts;
  mkdirSync(dir, { recursive: true });
  const report =
    opts.onError ?? ((room: string, error: unknown) => console.error(`[nbe] ${room}: écriture échouée`, error));

  const onRoomOpen = (room: string, transport: RoomTransport): (() => void) => {
    const store = new LoroBlockStore();
    const path = fileFor(dir, room);
    const onError = (error: unknown): void => report(room, error);

    loadSnapshot(store, path, onError);
    const flush = persistSnapshot(store, path, {
      debounceMs: saveDebounceMs,
      onSave: (bytes) => opts.onSave?.(room, bytes),
      onError,
    });
    const stop = connect(store, transport);

    return () => {
      stop();
      // the room is emptying: write now rather than lose the pending window
      flush();
    };
  };

  return startRelay({ ...opts, onRoomOpen });
}
