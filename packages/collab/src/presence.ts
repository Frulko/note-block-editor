import { EphemeralStore } from 'loro-crdt';
import { Message, envelope, type Transport } from './sync';

/**
 * Who else is here, and where they are looking.
 *
 * @remarks
 * §3 is explicit that ephemeral overlay state — cursors, selections,
 * highlights — "never enters the document or history". A remote caret is not
 * an edit: it should not be undoable, should not be saved, and should not
 * survive the person who left. So this is not stored in the CRDT at all.
 *
 * It rides the same socket as the document, tagged differently, because
 * opening a second connection to carry a few bytes would be worse. The
 * separation that matters is that nothing here is ever written to the CRDT.
 *
 * **Peers expire on their own.** A tab that closes, a laptop that sleeps or a
 * network that drops leaves no "goodbye" — so a presence keyed on
 * disconnection would leave ghosts sitting in a document forever. Each state
 * carries a lifetime and is dropped when it stops being refreshed, which makes
 * a lost peer indistinguishable from a quiet one, correctly.
 *
 * **The known limit.** A selection is a block id and two integer offsets, and
 * offsets do not survive someone else's edit: a remote caret at offset 5 is
 * wrong the instant a peer inserts before it. It is refreshed on every move so
 * it self-corrects in a moment, and being briefly wrong about where someone's
 * cursor is costs nothing. Loro's `Cursor` gives stable positions and is the
 * upgrade when a moment starts to feel long.
 *
 * @category Collaboration
 */

/** Where a peer is, as far as anyone else needs to know. */
export interface PeerState {
  /** What to call them. */
  name?: string;
  /** A colour for their caret, chosen by them so it is stable across sessions. */
  color?: string;
  /**
   * Where they are in the document, in whatever shape the view paints — a text
   * range, a set of held blocks, something a host invented. Opaque here: this
   * package carries it and never reads it, and spelling one shape out was how
   * three packages ended up with three copies of it that drifted apart.
   */
  selection?: unknown;
  /** Anything an application wants to share that is not an edit. */
  [key: string]: unknown;
}

export interface PresenceOptions {
  /** This peer's key. Stable for a session; not a user identity. */
  id: string;
  /** How long a state survives without a refresh. */
  timeoutMs?: number;
}

export interface Presence {
  /** Announce where this peer is. Replaces the previous announcement. */
  set(state: PeerState): void;
  /** Everyone else, keyed by peer. Never includes this peer. */
  peers(): Record<string, PeerState>;
  /** Called whenever anyone arrives, moves or times out. */
  onChange(handler: (peers: Record<string, PeerState>) => void): () => void;
  /** Say goodbye and stop listening. */
  leave(): void;
}

/** Default lifetime: long enough to survive a slow tab, short enough to notice. */
const DEFAULT_TIMEOUT = 30_000;

export function createPresence(transport: Transport, opts: PresenceOptions): Presence {
  const store = new EphemeralStore(opts.timeoutMs ?? DEFAULT_TIMEOUT);
  const handlers = new Set<(peers: Record<string, PeerState>) => void>();

  const others = (): Record<string, PeerState> => {
    const all = store.getAllStates() as Record<string, PeerState>;
    const { [opts.id]: _mine, ...rest } = all;
    return rest;
  };

  const announce = () => {
    for (const handler of handlers) handler(others());
  };

  const stopStore = store.subscribe(() => announce());
  const stopTransport = transport.onMessage((message) => {
    if (message[0] !== Message.Presence || message.length < 2) return;
    try {
      store.apply(message.subarray(1));
    } catch {
      // a peer speaking a version we cannot read is not a reason to stop
      // showing the ones we can
    }
  });

  return {
    set(state) {
      store.set(opts.id, state as never);
      transport.send(envelope(Message.Presence, store.encodeAll()));
    },

    peers: others,

    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    leave() {
      /*
       * Deleting and announcing is a courtesy, not the mechanism: the message
       * may never arrive. The timeout is what actually removes this peer, and
       * it works whether we left politely or the machine was closed.
       */
      store.delete(opts.id);
      transport.send(envelope(Message.Presence, store.encodeAll()));
      stopStore();
      stopTransport();
      handlers.clear();
    },
  };
}
