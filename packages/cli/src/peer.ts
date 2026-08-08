import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { LoroBlockStore, connect, connectToRelay, p2pTransport, type P2PState } from '@nbe/collab';
import { fileFor, loadSnapshot, persistSnapshot } from './snapshot';

/**
 * A peer-to-peer client with no screen.
 *
 * @remarks
 * The other side of `nbe serve`. That one *is* the relay and so holds every
 * room passing through it; this one dials a relay somebody else runs, joins one
 * room, and — once the WebRTC negotiation lands — keeps talking to the other
 * peers with the relay no longer in the path.
 *
 * **Why it exists, beyond the demo.** It is the only client of ours that can be
 * pointed at someone else's relay, which makes it the thing that tests
 * interoperability, and it is the shape a backup or a CI checkout wants: hold a
 * copy of a room on disk without running a server.
 *
 * **The `RTCPeerConnection` comes from `node-datachannel`.** Node has none, and
 * `@nbe/collab` must not grow a dependency to get one — it depends on `core`
 * and the CRDT and nothing else, which CI enforces. So the implementation is
 * injected here, in the package that is allowed to have it. The state machine
 * being tested is therefore exactly the one the browsers run.
 *
 * **Reconnection is here rather than in the transport**, which is where the
 * transport's own documentation puts it: how long to wait and whether to give
 * up differ between a browser tab and a process meant to run for months. This
 * one never gives up, because that is what unattended means.
 *
 * @category CLI
 */

export interface PeerOptions {
  /** The relay to dial, e.g. `ws://nas.local:8787`. */
  relay: string;
  /** The room to join. */
  room: string;
  /**
   * Where to keep the snapshot. Omit to hold the document in memory only,
   * which is what a connectivity check wants.
   */
  dir?: string;
  saveDebounceMs?: number;
  /** How long to wait before dialling again. */
  retryMs?: number;
  /** The mesh changed: peers seen, of which how many are direct. */
  onState?: (state: P2PState) => void;
  onSave?: (bytes: number) => void;
  onError?: (error: unknown) => void;
  /** Called on each dial, so a CLI can say what it is doing. */
  onConnect?: (attempt: number) => void;
}

export interface Peer {
  /** The document, live. */
  readonly store: LoroBlockStore;
  /** The last mesh state reported. */
  state(): P2PState;
  stop(): void;
}

export function startPeer(opts: PeerOptions): Peer {
  const store = new LoroBlockStore();
  const onError = opts.onError ?? ((error: unknown) => console.error('[nbe] pair', error));
  let state: P2PState = { peers: 0, direct: 0, relayed: true };
  let running = true;
  let disconnect: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const flush = opts.dir
    ? (() => {
        const path = fileFor(opts.dir, opts.room);
        loadSnapshot(store, path, onError);
        return persistSnapshot(store, path, {
          debounceMs: opts.saveDebounceMs,
          onSave: opts.onSave,
          onError,
        });
      })()
    : undefined;

  const dial = (): void => {
    if (!running) return;
    opts.onConnect?.(++attempt);
    /*
     * A fresh document is *not* created on reconnect: the store outlives every
     * socket, so coming back after an hour offline costs the version vector
     * handshake and the updates that were missed, not the whole document.
     */
    const signalling = connectToRelay(opts.relay, opts.room, {
      onClose: () => {
        disconnect?.();
        disconnect = undefined;
        state = { peers: 0, direct: 0, relayed: true };
        opts.onState?.(state);
        if (running) timer = setTimeout(dial, opts.retryMs ?? 2000);
      },
      // a socket error is followed by a close, which is where the retry lives
      onError: () => {},
    });
    disconnect = connect(
      store,
      p2pTransport(signalling, {
        PeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
        onState: (next) => {
          state = next;
          opts.onState?.(next);
        },
      }),
    );
  };

  dial();

  return {
    store,
    state: () => state,
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      disconnect?.();
      flush?.();
    },
  };
}
