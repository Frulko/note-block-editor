import type { Transport } from './sync';

/**
 * A transport over a WebSocket.
 *
 * @remarks
 * No dependency: `WebSocket` is a global in browsers and in Node since 22, and
 * this only needs the client half. The *server* half is a different matter and
 * lives in `@nbe/cli`.
 *
 * Messages are binary and opaque. The socket does not know it is carrying a
 * CRDT, which is what lets the same document sync over anything that moves
 * bytes.
 *
 * **Reconnection is the caller's business.** A transport that reconnected
 * silently would decide a policy — how often, how long, whether to give up —
 * that differs between a desktop app, a browser tab and a test. What this does
 * guarantee is that reconnecting is *cheap and correct*: the protocol opens
 * with a version vector, so a peer that comes back after an hour offline
 * receives exactly what it missed rather than the whole document.
 *
 * @category Collaboration
 */

export interface WebSocketTransportOptions {
  /** Called when the socket closes, so a caller can decide to reconnect. */
  onClose?: (event: { code: number; reason: string }) => void;
  /** Called on a socket error. Default: log it. */
  onError?: (error: unknown) => void;
}

/**
 * Wrap a socket as a transport.
 *
 * @param socket - An open or connecting socket. Messages sent before it opens
 * are queued rather than dropped, because `connect` announces a version vector
 * immediately and losing that announcement is a peer that never catches up.
 */
export function websocketTransport(socket: WebSocket, opts: WebSocketTransportOptions = {}): Transport {
  socket.binaryType = 'arraybuffer';
  const pending: Uint8Array[] = [];

  const flush = () => {
    while (pending.length) socket.send(pending.shift()!);
  };
  if (socket.readyState === WebSocket.OPEN) flush();
  else socket.addEventListener('open', flush, { once: true });

  socket.addEventListener('error', (event) => {
    if (opts.onError) opts.onError(event);
    else console.error('[collab] erreur de socket', event);
  });
  if (opts.onClose) {
    socket.addEventListener('close', (event) => opts.onClose!({ code: event.code, reason: event.reason }));
  }

  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(message);
      // closed or closing: dropping is right, and reconnecting replays the
      // version-vector handshake which recovers whatever was missed
    },

    onMessage(handler) {
      const listener = (event: MessageEvent) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) handler(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) handler(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        // a text frame is not ours: some proxies inject keepalives
      };
      socket.addEventListener('message', listener as EventListener);
      return () => socket.removeEventListener('message', listener as EventListener);
    },

    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    },
  };
}

/** Open a socket to a relay room and wrap it. */
export function connectToRelay(url: string, room: string, opts?: WebSocketTransportOptions): Transport {
  const address = new URL(url);
  address.searchParams.set('room', room);
  return websocketTransport(new WebSocket(address.toString()), opts);
}
