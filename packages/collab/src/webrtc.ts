import { Message, envelope, type Transport } from './sync';

/**
 * Peer-to-peer over WebRTC, with the relay as its own signalling server.
 *
 * @remarks
 * `docs/research/p2p-any-sync.md` has the reasoning; the two facts that shape
 * this file are:
 *
 * **Signalling is opaque bytes broadcast to a room, and a relay room already
 * is one.** So there is no signalling *server* to write — `nbe relay` gained
 * nothing for this. The offers, answers and ICE candidates ride the socket the
 * peers already opened, under one new message kind that older peers ignore by
 * design (`sync.ts`: "an unknown kind is a newer peer, not a broken one").
 *
 * **The relay is the TURN server.** Every honest WebRTC deployment needs a
 * relay for the connections that never go direct — measured at roughly one in
 * six, worse on mobile carriers. Ours is the WebSocket that is already open,
 * so the fallback is not a degraded mode with its own service, credentials and
 * port: it is the transport we shipped before this file existed.
 *
 * What this buys, then, is not "no server". It is that when the network allows
 * it, the server stops seeing the document — which is the part that actually
 * matters for a notes app.
 *
 * @category Collaboration
 */

/** A signalling message. JSON, because it is tens of bytes a few times per peer. */
interface Signal {
  from: string;
  /** Absent means "everyone in the room". */
  to?: string;
  kind: 'hello' | 'bye' | 'offer' | 'answer' | 'ice' | 'members';
  /** `members` only: how many peers the relay has in this room, us included. */
  count?: number;
  /** `hello` only: an answer to someone else's hello, so it is not answered back. */
  reply?: boolean;
  sdp?: { type: RTCSdpType; sdp?: string };
  ice?: RTCIceCandidateInit;
}

/** What the caller can show in a status line. */
export interface P2PState {
  /** Peers that have said hello. */
  peers: number;
  /** Of those, the ones reachable over an open data channel. */
  direct: number;
  /** True when the document no longer passes through the relay. */
  relayed: boolean;
}

export interface P2POptions {
  /** This peer's identity on the signalling channel. Default: random. */
  id?: string;
  /**
   * STUN, and TURN if you have one.
   *
   * @remarks
   * Default is a single public STUN server, which is enough to learn your own
   * public address on most networks. No TURN by default *on purpose*: the
   * relay already carries the fallback, so a TURN server would be a second
   * thing to host for a job that is already done.
   */
  iceServers?: RTCIceServer[];
  /**
   * The `RTCPeerConnection` implementation.
   *
   * @remarks
   * Injected rather than imported, because this package depends on `core` and
   * the CRDT and nothing else — a CI-enforced invariant. Browsers and the Tauri
   * webview have it as a global; Node does not, so `nbe peer` passes the one
   * from `node-datachannel/polyfill`.
   */
  PeerConnection?: typeof RTCPeerConnection;
  /** Called whenever the mesh changes, for a status indicator. */
  onState?: (state: P2PState) => void;
}

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** One remote peer. */
interface Link {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  /** We make the offer; the other side waits for it. */
  polite: boolean;
}

/**
 * Wrap a signalling transport as a peer-to-peer one.
 *
 * @param signalling - A connection to a room, typically `connectToRelay(...)`.
 * It stays in use: it carries the negotiation, and the document too until every
 * peer is reachable directly.
 * @returns A transport to hand to `connect()`. Closing it closes the signalling
 * one as well, so callers keep passing exactly one transport around.
 *
 * @example
 * ```ts
 * const stop = connect(store, p2pTransport(connectToRelay(url, room)))
 * ```
 */
export function p2pTransport(signalling: Transport, opts: P2POptions = {}): Transport {
  const me = opts.id ?? randomId();
  const RTCPeer = opts.PeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  const iceServers = opts.iceServers ?? STUN;
  const links = new Map<string, Link>();
  const handlers = new Set<(message: Uint8Array) => void>();
  let open = true;

  const state = (): P2PState => {
    const direct = [...links.values()].filter((link) => link.channel?.readyState === 'open').length;
    return { peers: links.size, direct, relayed: !links.size || direct < links.size };
  };
  const announce = (): void => opts.onState?.(state());

  const signal = (message: Omit<Signal, 'from'>): void => {
    signalling.send(envelope(Message.Signal, encode(JSON.stringify({ ...message, from: me }))));
  };

  const deliver = (message: Uint8Array): void => {
    for (const handler of handlers) handler(message);
  };

  const drop = (id: string): void => {
    const link = links.get(id);
    if (!link) return;
    links.delete(id);
    try {
      link.pc.close();
    } catch {
      // already gone
    }
    announce();
  };

  /**
   * Open a connection to a peer.
   *
   * @remarks
   * Who offers is decided by comparing the two ids, not by who arrived first.
   * That is the cheap way out of glare — both sides offering at once, which
   * needs the whole rollback dance of perfect negotiation to survive. With a
   * total order over the ids there is exactly one offerer and the case cannot
   * happen.
   */
  const linkTo = (id: string): Link | undefined => {
    if (!RTCPeer || links.has(id) || id === me) return links.get(id);
    const polite = me < id;
    const pc = new RTCPeer({ iceServers });
    const link: Link = { pc, polite };
    links.set(id, link);

    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ to: id, kind: 'ice', ice: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(id);
    };
    pc.ondatachannel = (event) => attach(id, link, event.channel);

    if (polite) {
      attach(id, link, pc.createDataChannel('nbe', { ordered: true }));
      void (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signal({ to: id, kind: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
        } catch {
          drop(id);
        }
      })();
    }

    announce();
    return link;
  };

  const attach = (id: string, link: Link, channel: RTCDataChannel): void => {
    channel.binaryType = 'arraybuffer';
    link.channel = channel;
    channel.onopen = announce;
    channel.onclose = () => {
      // the peer is still in the room and may re-offer; only the direct path died
      if (link.channel === channel) link.channel = undefined;
      announce();
    };
    channel.onmessage = (event) => {
      if (!open) return;
      const data = event.data as ArrayBuffer | ArrayBufferView | string;
      if (typeof data === 'string') return; // not ours
      deliver(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    };
  };

  const onSignal = async (message: Signal): Promise<void> => {
    if (message.from === me) return;
    if (message.to && message.to !== me) return;

    switch (message.kind) {
      case 'hello': {
        // answer a first hello so the newcomer learns about us; never answer an
        // answer, or two peers greet each other until one of them leaves
        if (!message.reply) signal({ to: message.from, kind: 'hello', reply: true });
        linkTo(message.from);
        return;
      }
      case 'bye':
        return drop(message.from);
      case 'offer': {
        // an offer can arrive before the hello that announced its sender
        const link = links.get(message.from) ?? linkTo(message.from);
        if (!link || !message.sdp) return;
        try {
          await link.pc.setRemoteDescription(message.sdp as RTCSessionDescriptionInit);
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          signal({ to: message.from, kind: 'answer', sdp: { type: answer.type, sdp: answer.sdp } });
        } catch {
          drop(message.from);
        }
        return;
      }
      case 'answer': {
        const link = links.get(message.from);
        if (!link || !message.sdp) return;
        try {
          await link.pc.setRemoteDescription(message.sdp as RTCSessionDescriptionInit);
        } catch {
          drop(message.from);
        }
        return;
      }
      case 'ice': {
        const link = links.get(message.from);
        if (!link || !message.ice) return;
        try {
          await link.pc.addIceCandidate(message.ice);
        } catch {
          // a candidate that arrives before the remote description, or for a
          // connection already established, is normal and not worth a teardown
        }
        return;
      }
    }
  };

  const stopListening = signalling.onMessage((message) => {
    if (!message.length) return;
    if (message[0] !== Message.Signal) {
      // the document, still coming over the relay: hand it up unchanged
      deliver(message);
      return;
    }
    let parsed: Signal;
    try {
      parsed = JSON.parse(decode(message.subarray(1))) as Signal;
    } catch {
      return;
    }
    void onSignal(parsed);
  });

  if (RTCPeer) signal({ kind: 'hello' });
  else console.warn('[collab] pas de RTCPeerConnection : le document passe par le relais');

  return {
    /**
     * Direct when it is direct for *everyone*, the relay otherwise.
     *
     * @remarks
     * ponytail: an all-or-nothing switch. With one peer meshed and one still
     * negotiating, this sends over the relay — which reaches both — rather than
     * over the channel *and* the relay, which would reach the meshed peer
     * twice. Duplicate updates are idempotent, so that is a bandwidth choice,
     * not a correctness one. Split it per-peer if a room ever holds enough
     * people for one bad link to hold the rest on the relay.
     */
    send(message) {
      if (!open) return;
      const all = [...links.values()];
      if (all.length && all.every((link) => link.channel?.readyState === 'open')) {
        for (const link of all) link.channel!.send(message as unknown as ArrayBufferView);
      } else {
        signalling.send(message);
      }
    },

    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    close() {
      if (!open) return;
      open = false;
      signal({ kind: 'bye' });
      for (const id of [...links.keys()]) drop(id);
      stopListening();
      signalling.close?.();
    },
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Enough to be unique in a room, and ordered, which is all the protocol asks. */
function randomId(): string {
  const bytes = new Uint8Array(8);
  (globalThis.crypto ?? ({ getRandomValues: () => bytes } as never)).getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
