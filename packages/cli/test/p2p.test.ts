import { afterAll, describe, expect, it } from 'vitest';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import { LoroBlockStore, connect, connectToRelay, p2pTransport, type P2PState } from '@nbe/collab';
import { startRelay } from '../src/relay';

/**
 * The peer-to-peer claim, tested rather than drawn.
 *
 * @remarks
 * `docs/research/p2p-any-sync.md` argues that "fully peer-to-peer" is a
 * spectrum and that the honest version of it is: signal through a relay, then
 * stop using it. This file is the only proof that the second half happens.
 *
 * **The relay is killed mid-test on purpose.** Asserting that two peers
 * converge while the relay is still up proves nothing — they would converge
 * over it. So the test meshes them, closes the relay, *then* types. If the
 * edit still arrives, it went over the data channel, because there is nothing
 * else left.
 *
 * Real WebRTC, not a mock: `node-datachannel` is the same libdatachannel the
 * browsers' ICE stacks are compared against, and its polyfill gives the
 * `RTCPeerConnection` the browser has as a global. A mock would have tested our
 * state machine against our idea of WebRTC, which is the part most likely to be
 * wrong.
 */

afterAll(() => cleanup());

/** Resolve once `predicate` holds, or fail loudly rather than hang the suite. */
async function until(predicate: () => boolean, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const paragraph = (id: string, text: string) => ({
  id,
  type: 'paragraph' as const,
  version: 1,
  props: {},
  children: [],
  parentId: null,
  text: text ? [{ text }] : [],
});

describe('p2p over WebRTC, signalled by the relay', () => {
  it('meshes two peers, then carries the document with the relay gone', async () => {
    const relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;

    const alice = new LoroBlockStore();
    const basile = new LoroBlockStore();
    const states: Record<string, P2PState> = {};

    // ICE with no servers at all: both peers are on this machine, so host
    // candidates are enough and a STUN round trip would only slow the test
    const options = { PeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, iceServers: [] as RTCIceServer[] };
    const left = p2pTransport(connectToRelay(url, 'salon'), {
      ...options,
      id: 'aaaa',
      onState: (state) => (states['alice'] = state),
    });
    const right = p2pTransport(connectToRelay(url, 'salon'), {
      ...options,
      id: 'bbbb',
      onState: (state) => (states['basile'] = state),
    });
    const stopA = connect(alice, left);
    const stopB = connect(basile, right);

    await until(() => states['alice']?.relayed === false && states['basile']?.relayed === false, 'maillage');
    expect(states['alice']).toEqual({ peers: 1, direct: 1, relayed: false });

    await relay.close();
    // let the socket closures land, so nothing is in flight over the relay
    await new Promise((resolve) => setTimeout(resolve, 200));

    alice.set('un', paragraph('un', 'écrit sans serveur'));
    await until(() => firstText(basile) === 'écrit sans serveur', 'convergence en p2p');

    // and back, because a data channel that only worked one way would pass the
    // assertion above
    basile.set('deux', paragraph('deux', 'et dans l’autre sens'));
    await until(() => alice.get('deux') !== undefined, 'convergence en sens inverse');

    stopA();
    stopB();
  }, 40_000);

  it('stays on the relay while a peer that cannot mesh is in the room', async () => {
    /*
     * The failure this prevents: two browsers mesh, stop touching the relay,
     * and `nbe serve` silently stops receiving the document. A peer that does
     * not speak WebRTC never announces itself, so peers counting each other
     * cannot see it — only the relay can, which is why it reports membership.
     */
    const relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;

    const plain = new LoroBlockStore();
    const stopPlain = connect(plain, connectToRelay(url, 'mixte'));

    const stores = [new LoroBlockStore(), new LoroBlockStore()];
    const states: P2PState[] = [];
    const stops = stores.map((store, index) =>
      connect(
        store,
        p2pTransport(connectToRelay(url, 'mixte'), {
          PeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
          iceServers: [],
          id: `peer-${index}`,
          onState: (state) => (states[index] = state),
        }),
      ),
    );

    await until(() => states.length === 2 && states.every((state) => state.direct === 1), 'canaux ouverts');
    // both have a direct channel to each other and are *still* relayed, because
    // the relay says the room holds three
    expect(states.every((state) => state.relayed)).toBe(true);

    stores[0]!.set('un', paragraph('un', 'visible par le nœud'));
    await until(() => firstText(plain) === 'visible par le nœud', 'le pair non maillé reçoit');

    for (const stop of stops) stop();
    stopPlain();
    await relay.close();
  }, 40_000);
});

/** The text of the first paragraph, or undefined. */
function firstText(store: LoroBlockStore): string | undefined {
  for (const id of ['un', 'deux']) {
    const block = store.get(id);
    if (block?.text?.length) return block.text.map((span) => span.text).join('');
  }
  return undefined;
}
