# any-sync, and what "fully peer-to-peer over WebRTC" actually costs

Researched 2026-08-08, prompted by "dig into any-sync's p2p tooling — we want a
fully p2p WebRTC system, no?". The short answer is **any-sync is peer-to-peer
and contains no WebRTC at all**, and the reason it does not is the same reason
we should not aim for "fully p2p" either. What follows is what the code says,
not what the marketing page says.

## What any-sync actually is

Four server node types, each a separate Go program with its own repository:
`any-sync-coordinator` (network configuration and space registration),
`any-sync-consensusnode` (ACL change validation), `any-sync-node` (stores
spaces and objects), `any-sync-filenode` (binary storage, S3 + Redis). A
production deployment is those four plus MongoDB, Redis and S3.

`net/` in `anyproto/any-sync` holds: `connutil`, `peer`, `peerservice`, `pool`,
`rpc`, `secureservice`, `streampool`, `transport`. **There is no `discovery`
package and no `webrtc` package.** `net/transport/` has exactly four entries:
`quic`, `yamux`, `webtransport`, `mock_transport`.

- **QUIC** (`net/transport/quic/quic.go`) dials with `quic.Dial` over an
  ephemeral UDP port, uses **libp2p-TLS** for mutual authentication, derives
  the remote peer ID from the TLS certificate's public key, and sets the ALPN
  to `anysync`. There is **no NAT traversal logic in the file** — no STUN, no
  hole punching, no relay negotiation. It assumes the UDP path exists.
- **Yamux over TCP** is the reliable fallback multiplexer.
- **WebTransport** is the browser-reachable one, and it is HTTP/3, not WebRTC.
  It reaches a *server*, not another browser.

So the identity model is what our own `sync-protocol.md` already picked
independently — a keypair is the peer ID, no account server in the transport —
and the transport model is "dial an address you were told about".

## Where the peer-to-peer part lives

Not in `any-sync`. Anytype's LAN peer-to-peer is in the **client**
(`anytype-heart`): mDNS on the local network, then a direct QUIC or TCP dial to
the address it just learned. That is genuinely peer-to-peer, genuinely
serverless, and genuinely **local-network only**. The open issue asking for
manually configured peers (anytype-heart#1341) exists precisely because mDNS
fails on networks that block multicast, and there is no other way in.

Off the LAN, "peer-to-peer" means *through a sync node*: an always-on server
that holds the encrypted DAG and forwards it. End-to-end encrypted, so the node
cannot read it — but it is a server, it is dialled by address, and without it
two Anytype users on different networks do not sync.

**This is the design, not a shortcoming.** Two things force it, and they would
force it on us identically:

1. **Reachability.** Two residential devices behind CGNAT cannot open a socket
   to each other without a third party. Anytype's third party is a sync node.
2. **Availability.** Peer-to-peer sync requires both peers online *at the same
   time*. A phone edited on the train and a laptop opened that evening never
   overlap. Anytype's answer is a node that never leaves — which is exactly
   what our `nbe serve` already is.

## The honest answer on WebRTC

"Fully peer-to-peer over WebRTC" is not a thing that exists, and it is worth
being precise about why, because every part of it is a server:

| What WebRTC needs | What it actually is |
| --- | --- |
| **Signalling** — exchange SDP and ICE candidates | A server. WebRTC has no opinion on how; you build it. |
| **STUN** — learn your own public address | A server. Free public ones exist; they are still someone's. |
| **TURN** — when hole punching fails | A **relay server**, carrying every byte. |

Published measurements from the people who run this in production put direct
connection failure in the 8–20% range depending on the population, and it is
worse on carrier-grade NAT and symmetric NAT — i.e. mobile. A TURN server is
not the exotic fallback; it is the thing that makes the product work for the
last fifth of users, and it costs bandwidth per byte.

Add the browser-specific problems: a WebRTC peer cannot discover anything on
the LAN (ICE mDNS candidates are deliberately obfuscated to prevent local-IP
fingerprinting), a tab that closes takes its half of the mesh with it, and a
full mesh of *n* peers is O(n²) connections.

So: **WebRTC does not remove the server. It changes what the server carries.**
That is still a real win, and it is the one worth taking.

## What we are building, and why it is the honest version

Carnet already has a relay: `nbe relay` forwards opaque bytes between the
members of a room and understands nothing (`packages/cli/src/relay.ts`), and
`nbe serve` is that plus a peer that never leaves. The room is already a
broadcast bus for opaque messages.

**Signalling is opaque bytes broadcast to a room.** So the relay needs no new
code to become the signalling server — it already is one. We add one message
kind (`Message.Signal = 3`) to the wire protocol, which existing peers already
ignore by design ("an unknown kind is a newer peer, not a broken one").

**The relay is the TURN server.** Not a separate coturn deployment with its own
credentials: when the data channel is not open, the bytes go over the WebSocket
that is already there and already carried the signalling. One service, one
port, one thing to host. This is strictly less infrastructure than the standard
WebRTC stack, and it is why the fallback is not a degraded mode — it is the
mode we already shipped and tested.

**So the transport is a ladder, and every rung is real:**

| Rung | Path | Server involvement |
| --- | --- | --- |
| Direct | WebRTC data channel, host or server-reflexive candidates | signalling only, then nothing |
| Fallback | the relay's WebSocket | forwards every byte |
| Absent | `nbe serve` holds the document | a peer that never leaves |

`p2pTransport` in `packages/collab/src/webrtc.ts` is one `Transport` that
climbs it: it takes the relay connection as its signalling channel, meshes with
whoever answers, and switches to the data channels **only once every known peer
has one**. Mixed states stay on the relay rather than sending down both paths —
duplicate CRDT updates are idempotent, so the choice is about bandwidth, not
correctness.

## What we deliberately did not take from any-sync

- **Its four node types.** Coordinator, consensus, file and sync nodes exist to
  run a *network* for many tenants. We have one relay and a keypair.
- **Its consensus node for ACLs.** `sync-protocol.md` already stated the trap:
  an ACL cannot be an ordinary CRDT. Anytype's answer is a dedicated node with
  MongoDB. Ours stays an owner-signed ACL with a monotonic version.
- **QUIC.** It is the better transport and it is unreachable from a browser,
  which is our primary target. WebTransport would be the equivalent, and it
  buys nothing over the WebSocket we have until the relay is a bottleneck.

## What we took

- **The identity model.** A keypair *is* the peer, derived from a public key,
  no registry. Already our decision, now corroborated by an implementation that
  runs in production.
- **The shape of the answer to reachability**: direct when the network allows
  it, an always-on node when it does not, and never pretend the second is a
  failure of the first.
- **mDNS on the LAN, which we still do not have** and which remains the best
  value per line of code on the list — for the native clients only, because the
  browser cannot have it. `nbe peer` is where it would land.

## The claim to test, not assert

Two browsers in a room reach a data channel and the relay stops seeing document
traffic. That is `e2e/p2p.spec.ts`, and it is the only proof that any of this
is more than a diagram.
