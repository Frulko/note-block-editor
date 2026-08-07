import { afterEach, describe, expect, it } from 'vitest';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore, connect, connectToRelay } from '@nbe/collab';
import { startRelay, type Relay } from '../src/relay';

/**
 * Two peers through a real relay.
 *
 * @remarks
 * Not a loopback: a real HTTP server, real sockets, real frames. The loopback
 * tests prove the protocol; this proves that the protocol survives a wire —
 * asynchronous delivery, a connection that has to open before anything can be
 * sent, and a relay that has no idea what it is forwarding.
 */

let relay: Relay | null = null;

afterEach(async () => {
  await relay?.close();
  relay = null;
});

function storeWithRoot() {
  const store = new LoroBlockStore();
  const rootId = uuidv7();
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  return { store, rootId };
}

const paragraph = (parentId: BlockId, text: string): Block => ({
  id: uuidv7(),
  type: 'paragraph',
  version: 1,
  props: {},
  children: [],
  parentId,
  text: [{ text }],
});

/** Wait until a condition holds, or give up. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('délai dépassé');
}

describe('a relay carries a document between peers', () => {
  it('a peer joining later receives what it missed', async () => {
    relay = await startRelay();
    const url = `ws://localhost:${relay.port}`;

    const { store: alice, rootId } = storeWithRoot();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'écrit avant que Bob arrive');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    connect(alice, connectToRelay(url, 'salle'));
    const bob = new LoroBlockStore();
    connect(bob, connectToRelay(url, 'salle'));

    await until(() => bob.get(block.id)?.text?.[0]?.text === 'écrit avant que Bob arrive');
    expect(bob.get(block.id)?.text?.[0]?.text).toBe('écrit avant que Bob arrive');
  });

  it('an edit made while connected arrives', async () => {
    relay = await startRelay();
    const url = `ws://localhost:${relay.port}`;
    const { store: alice, rootId } = storeWithRoot();
    const bob = new LoroBlockStore();
    connect(alice, connectToRelay(url, 'salle'));
    connect(bob, connectToRelay(url, 'salle'));
    await until(() => relay!.size('salle') === 2);

    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'en direct');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    await until(() => bob.get(block.id) !== undefined);
    expect(bob.get(block.id)?.text?.[0]?.text).toBe('en direct');
  });

  it('rooms are separate, so two documents do not mix', async () => {
    relay = await startRelay();
    const url = `ws://localhost:${relay.port}`;
    const { store: alice, rootId } = storeWithRoot();
    const stranger = new LoroBlockStore();
    connect(alice, connectToRelay(url, 'la-mienne'));
    connect(stranger, connectToRelay(url, 'une-autre'));
    await until(() => relay!.size('la-mienne') === 1 && relay!.size('une-autre') === 1);

    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'privé');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(stranger.has(block.id)).toBe(false);
    expect(stranger.size).toBe(0);
  });

  it('a room is forgotten once everyone leaves', async () => {
    relay = await startRelay();
    const url = `ws://localhost:${relay.port}`;
    const { store } = storeWithRoot();
    const stop = connect(store, connectToRelay(url, 'éphémère'));
    await until(() => relay!.size('éphémère') === 1);
    stop();
    // the document lives on the peers; the relay holds nothing
    await until(() => relay!.size('éphémère') === 0);
    expect(relay!.size('éphémère')).toBe(0);
  });

  it('a refused connection never joins', async () => {
    relay = await startRelay({ authorize: ({ room }) => room !== 'interdite' });
    const url = `ws://localhost:${relay.port}`;
    const store = new LoroBlockStore();
    connect(store, connectToRelay(url, 'interdite'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(relay.size('interdite')).toBe(0);
  });
});
