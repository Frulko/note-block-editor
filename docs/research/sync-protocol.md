# Decision: the sync protocol, identity, and ActivityPub

Researched 2026-08-07, prompted by the question "could ActivityPub be an
interesting lead?". The short answer is **no for sync, yes for one narrow
optional feature** — and the reason is worth writing down, because it applies
to every protocol we looked at.

## The framing that settles most of it

Four problems get conflated constantly, and almost every "which protocol"
argument is someone shopping for a package deal that does not exist:

| Concern | The question it answers |
| --- | --- |
| **Transport** | how do bytes move between two replicas |
| **Identity** | who is this replica, or this person |
| **Discovery** | where is the peer right now |
| **Authorization** | may these bytes be handed to a CRDT at all |

Loro already solves *merge*. Carnet needs the other four, and they do not have
to come from one protocol. Keeping them apart is most of the answer.

## Verdict on ActivityPub

**Not for sync.** Not "later", not "with extensions" — it is structurally
wrong for the job, and the spec says so itself:

- **Update semantics are fatal.** Client-to-server `Update` is a partial patch,
  but server-to-server `Update` — the federation side — *requires "a complete
  replacement of the object"*. A CRDT protocol is nothing but deltas. Full
  replacement means shipping the whole document per change, and the receiver
  has no way to express "merge this", only "overwrite".
- **No delivery guarantees**, no ordering, no dedup, no acknowledgement, no
  resume-from-version. CRDTs tolerate that, which means AP gives us none of
  the things a sync protocol exists to give us; we would reimplement version
  vector negotiation on top anyway.
- **Authorization is explicitly out of scope.** The spec states there are no
  strongly agreed mechanisms and punts. For our hardest problem — §3's rule
  that access must be enforced *before* bytes reach a CRDT — it contributes
  nothing.

Corroborating: the one ecosystem that actually needed federated document
sharing (Nextcloud and friends) built Open Cloud Mesh, not ActivityPub.

**Where it does fit**, later and optionally: publishing. A page marked public
becomes an ActivityStreams `Article` in an actor's outbox; a notebook becomes
something you can follow. That is ActivityPub used as RSS-with-push, which is
what it is good at. It reads from the canonical JSON and never writes back. It
must not touch the sync path.

## What we should use instead

**Transport: a WebSocket to a node you can self-host, carrying CRDT deltas.**
This is the boring consensus and it survives scrutiny — even Automerge's
next-generation sync protocol (Beelay), the most sophisticated design in this
space, assumes a WebSocket underneath. The p2p options do not beat it where we
need it most: iroh is the best of them and is documented as *relay-only in the
browser*, which is our primary target, so it degrades to exactly what we would
have built plus a WASM blob. `y-webrtc`, the cautionary tale, has not been
published since 2023 while `y-websocket` shipped this month.

We already have this, and it is tested: `packages/collab` speaks version
vectors over a pluggable transport, and `nbe serve` is a peer that never
leaves. **Worth evaluating, not yet adopted:** `loro-dev/protocol` is
first-party and offers message framing, rooms multiplexed over one connection,
acknowledgements, and auth/persistence hooks — the same shape we built by hand.
Its `loro-websocket` was last published seven months before `loro-crdt`, so its
maturity needs checking before we trade working, tested code for it.

**Identity: a per-device Ed25519 keypair, encoded as `did:key`.** No registry,
no directory, no account server. An account is a *set of device keys*: adding a
device means an existing device signs the new one, paired by QR code or a short
code over the LAN. This is the highest-leverage decision available, because it
deletes an entire service.

**Discovery: a URL you typed, plus mDNS on the LAN.** No DHT — DHT chatter is
what shows up in reviews as "drains my battery".

**Authorization: the server refuses to forward.** The node authenticates the
connection and checks a per-document ACL before relaying a byte. Our relay's
own documentation already states the principle; this is what implements it.

## The trap worth writing down

**The ACL must not be an ordinary CRDT.** "Alice adds Carol" concurrent with
"Bob removes Alice" has no conflict-free answer that is also secure: add-wins
leaks, remove-wins is a denial of service. The affordable answer is an
owner-signed ACL with a monotonic version, last-writer-wins by signature —
one writer for permissions, multi-owner deferred rather than broken. Anytype
runs a dedicated *consensus node* for this, and the price of doing it properly
today is MongoDB plus Redis plus S3.

**And an impossibility to state in the UI rather than discover in an incident:**
you cannot have both revocation and forward secrecy without re-encryption.
Revoking access means rotating the document key, and whatever the revoked party
already synced, they keep. Every local-first product that hid this had to
explain it later.

## Sequencing

**Rung 0, which deserves a real look before anything is built:** Carnet is
file-over-app with a Markdown vault. Much of the demand for "sync" is one
person on several devices, and iCloud Drive or Syncthing already do that. If
the Loro oplog is persisted as append-only files beside the vault, dumb file
sync merges correctly. Zero infrastructure, zero protocol, zero keys. It fails
only for real-time multi-user and for conflicting edits inside one sync window.

**Minimum viable:** device keypair in the OS keychain, challenge-response at
connect, owner-signed ACL checked by the node, 12-factor configuration
(`PORT`, `DATA_DIR`, `LOG_LEVEL`), SQLite snapshots, TLS at the reverse proxy.
Presence over the same socket, never persisted. Deferred on purpose: E2EE,
p2p, NAT traversal, federation, UCAN, multi-owner ACLs, passkeys.

**Then, in dependency order:** mDNS on the LAN (the best value per line of
code on this list); end-to-end encryption with the server relaying ciphertext;
UCAN delegation when sharing needs to be transitive; iroh for reachability —
whose honest use case is not ideology but "my NAS is behind CGNAT and I will
not explain port forwarding"; and the ActivityPub publishing adapter.

## Rejected, with reasons

- **AT Protocol** — repositories are "entirely public and verifiable", no
  encryption, no private records. A public-social substrate. Steal one idea:
  handle-as-domain-name is good UX and costs a DNS lookup.
- **Matrix** — a hard 64 KiB event ceiling, unbounded room state, expensive
  state resolution. A homeserver on a NAS to move deltas is orders of magnitude
  more machinery than a socket.
- **Nostr** — signed JSON, no partial updates, no binary type, and relays
  guarantee neither storage nor delivery. Right about keypairs, wrong about
  everything else.
- **Solid / remoteStorage** — whole-resource `PUT`, no CRDT or delta
  provisions. A storage backend one day, never a sync protocol.
- **libp2p** — a very large dependency to obtain a connection `new WebSocket()`
  already makes.
- **Willow / Meadowcap** — the closest design to what we actually need, and
  `willow-rs` was archived in October 2025. Read Meadowcap for its capability
  model; depend on none of it.
- **Hypercore/Holepunch, Veilid, iroh-docs** — a whole runtime, an anonymity
  framework, and a second merge model beside Loro's. Wrong layer each time.

## Uncertain, flagged rather than guessed

`loro-protocol`'s stability commitment and its publish gap; whether iroh's
browser story changed after 1.0; the exact Matrix size limit against the
current spec text; and Loro's own E2EE construction, which was referenced but
not reviewed. Anything load-bearing here should be confirmed before it is built
on.

## Mobile, which is not a protocol choice

iOS background execution is discretionary: `BGTaskScheduler` gives no
guaranteed window, and a force-quit kills silent push delivery outright with no
workaround. Design for "sync on foreground, nudged by push". This constraint is
identical for every option above, so it must not be used to choose between
them.
