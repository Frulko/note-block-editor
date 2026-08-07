import { VersionVector } from 'loro-crdt';
import type { LoroBlockStore } from './store';

/**
 * Moving updates between peers.
 *
 * @remarks
 * The roadmap asks for "opaque update blobs over pluggable transports", and
 * both halves of that matter. **Opaque**, because the ops carry integer
 * positions and are a local application format — sending them would
 * reintroduce the trap the op design exists to avoid. **Pluggable**, because
 * the same document should sync over a websocket relay today, a peer-to-peer
 * link on a native client later, and a loopback in a test, without the
 * document knowing which.
 *
 * So a transport here is two methods. It does not reconnect, authenticate,
 * batch or retry: those differ per transport and belong to whichever one is
 * being written. Access control in particular stays *outside* — a CRDT merges
 * whatever it is handed, so a peer that should not have written must be
 * stopped before the blob arrives, not after.
 *
 * @category Collaboration
 */

export interface Transport {
  /** Hand a message to the other side. */
  send(message: Uint8Array): void;
  /** Receive messages. Returns a function that stops listening. */
  onMessage(handler: (message: Uint8Array) => void): () => void;
  close?(): void;
}

/**
 * The wire protocol, which is two message kinds and one byte.
 *
 * @remarks
 * A peer opens by announcing what it already has; the other side replies with
 * exactly what is missing. Sending a whole snapshot instead would be one
 * message type and much simpler — and would make every reconnection cost the
 * size of the document. On the measured sample the difference was 104 bytes
 * against 372, and that ratio grows with history.
 */
const enum Message {
  /** "This is my version vector." Answer with what I do not have. */
  Have = 0,
  /** "Here is an update." Apply it. */
  Update = 1,
}

function envelope(kind: Message, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = kind;
  out.set(payload, 1);
  return out;
}

/**
 * Keep a store in sync over a transport.
 *
 * @param store - The document. Its local edits are sent; remote ones applied.
 * @returns A function that stops syncing and closes the transport.
 *
 * @example
 * ```ts
 * const stop = connect(store, websocketTransport(socket))
 * ```
 */
export function connect(store: LoroBlockStore, transport: Transport): () => void {
  const doc = store.doc;

  const stopListening = transport.onMessage((message) => {
    if (!message.length) return;
    const payload = message.subarray(1);
    switch (message[0]) {
      case Message.Have:
        // reply with everything this peer is missing, and nothing else
        transport.send(envelope(Message.Update, doc.export({ mode: 'update', from: decodeVersion(payload) })));
        break;
      case Message.Update:
        if (payload.length) store.import(payload);
        break;
      default:
        // an unknown kind is a newer peer, not a broken one: ignore it rather
        // than close a connection that still works for what we do understand
        break;
    }
  });

  /*
   * `by === 'local'` is what stops an echo: importing a peer's update fires
   * this too, and sending it back would bounce the same bytes between two
   * peers until one of them stopped.
   */
  const unsubscribe = doc.subscribe((event) => {
    if (event.by !== 'local') return;
    transport.send(envelope(Message.Update, doc.export({ mode: 'update' })));
  });

  transport.send(envelope(Message.Have, encodeVersion(doc)));

  return () => {
    unsubscribe();
    stopListening();
    transport.close?.();
  };
}

/** A version vector, as bytes. */
function encodeVersion(doc: LoroBlockStore['doc']): Uint8Array {
  return doc.version().encode();
}

function decodeVersion(bytes: Uint8Array): ReturnType<LoroBlockStore['doc']['version']> | undefined {
  if (!bytes.length) return undefined;
  try {
    return VersionVector.decode(bytes);
  } catch {
    // an unreadable vector means "send me everything", which is correct and
    // slower rather than wrong
    return undefined;
  }
}

/**
 * A pair of transports wired to each other, for tests and for two views in one
 * process.
 *
 * @remarks
 * Delivery is asynchronous on purpose. A synchronous loopback would hide every
 * ordering bug a real network makes routine, and those are the bugs worth
 * catching here.
 */
export function loopback(): [Transport, Transport] {
  const handlers: Array<Set<(message: Uint8Array) => void>> = [new Set(), new Set()];
  let open = true;

  const make = (self: 0 | 1): Transport => ({
    send(message) {
      if (!open) return;
      const other = handlers[self === 0 ? 1 : 0]!;
      queueMicrotask(() => {
        for (const handler of other) handler(message);
      });
    },
    onMessage(handler) {
      handlers[self]!.add(handler);
      return () => handlers[self]!.delete(handler);
    },
    close() {
      open = false;
    },
  });

  return [make(0), make(1)];
}
