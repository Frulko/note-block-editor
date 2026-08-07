import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A relay: it forwards bytes between the peers in a room.
 *
 * @remarks
 * It knows nothing about CRDTs, documents or blocks — a message that arrives
 * is sent to everyone else in the room, and that is the whole of it. That is
 * deliberate and it is the Automerge-Repo shape: **a relay that cannot
 * understand the data cannot corrupt it**, cannot need upgrading when the
 * document format changes, and can be replaced by any pipe that moves bytes.
 *
 * It is also why this is not the sync engine. Peers reconcile with each other
 * using version vectors (`@nbe/collab`); the relay does not track who has what,
 * so it holds no state that could be wrong.
 *
 * **What it deliberately does not do.** No persistence: a room exists while
 * someone is in it, and a peer joining an empty room gets nothing — the
 * document lives on the peers, which is what local-first means. No
 * authentication: access control belongs outside the CRDT, because a CRDT
 * merges whatever it is handed, so the check has to happen before the bytes
 * arrive. Put this behind a reverse proxy that authenticates, or wrap
 * `verifyClient`.
 *
 * @category Collaboration
 */

export interface RelayOptions {
  port?: number;
  /** Refuse a connection before it joins a room. */
  authorize?: (request: { room: string; url: string; headers: Record<string, unknown> }) => boolean;
  /** Called on each join and leave, for logging. */
  onChange?: (room: string, peers: number) => void;
}

export interface Relay {
  readonly port: number;
  /** How many peers are in a room. */
  size(room: string): number;
  close(): Promise<void>;
}

/** Rooms hold sockets, and nothing else. */
type Rooms = Map<string, Set<WebSocket>>;

function roomOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://relay').searchParams.get('room') ?? 'default';
  } catch {
    return 'default';
  }
}

export function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const rooms: Rooms = new Map();
  const http: Server = createServer((_request, response) => {
    // a plain GET is a health check, not an error
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('nbe relay\n');
  });
  const sockets = new WebSocketServer({ server: http });

  sockets.on('connection', (socket, request) => {
    const room = roomOf(request.url);
    if (opts.authorize && !opts.authorize({ room, url: request.url ?? '', headers: request.headers })) {
      socket.close(1008, 'non autorisé');
      return;
    }

    const peers = rooms.get(room) ?? new Set<WebSocket>();
    peers.add(socket);
    rooms.set(room, peers);
    opts.onChange?.(room, peers.size);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return; // not ours; some proxies send text keepalives
      for (const peer of peers) {
        if (peer !== socket && peer.readyState === peer.OPEN) peer.send(data, { binary: true });
      }
    });

    const leave = () => {
      peers.delete(socket);
      if (peers.size === 0) rooms.delete(room);
      opts.onChange?.(room, peers.size);
    };
    socket.on('close', leave);
    socket.on('error', leave);
  });

  return new Promise((resolve) => {
    http.listen(opts.port ?? 0, () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
      resolve({
        port,
        size: (room) => rooms.get(room)?.size ?? 0,
        close: () =>
          new Promise<void>((done) => {
            for (const peers of rooms.values()) for (const socket of peers) socket.terminate();
            sockets.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
