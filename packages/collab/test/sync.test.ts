import { describe, expect, it } from 'vitest';
import { Editor, getBlock, textCaret, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore } from '../src/store';
import { connect, loopback } from '../src/sync';

/**
 * Two peers on a wire.
 *
 * @remarks
 * The transport is deliberately asynchronous, so these tests await delivery
 * rather than assert immediately. A synchronous loopback would pass while
 * hiding every ordering problem a real network makes routine.
 */

function storeWithRoot() {
  const store = new LoroBlockStore();
  const rootId = uuidv7();
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  return { store, rootId };
}

const paragraph = (parentId: BlockId, text = ''): Block => ({
  id: uuidv7(),
  type: 'paragraph',
  version: 1,
  props: {},
  children: [],
  parentId,
  text: text ? [{ text }] : [],
});

/** Let queued messages arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a connection catches a peer up', () => {
  it('sends what the other side is missing on connect', async () => {
    const { store: alice, rootId } = storeWithRoot();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'écrit avant la connexion');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    const bob = new LoroBlockStore();
    const [left, right] = loopback();
    connect(alice, left);
    connect(bob, right);
    await settle();

    expect(bob.get(block.id)?.text?.[0]?.text).toBe('écrit avant la connexion');
  });

  it('an empty peer receives the whole document', async () => {
    const { store: alice, rootId } = storeWithRoot();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'un'), index: 0 }));

    const bob = new LoroBlockStore();
    const [left, right] = loopback();
    connect(alice, left);
    connect(bob, right);
    await settle();
    expect(bob.size).toBe(alice.size);
  });
});

describe('edits flow while connected', () => {
  async function connected() {
    const { store: alice, rootId } = storeWithRoot();
    const bob = new LoroBlockStore();
    const [left, right] = loopback();
    const stopA = connect(alice, left);
    const stopB = connect(bob, right);
    await settle();
    return { alice, bob, rootId, stop: () => (stopA(), stopB()) };
  }

  it('a block written on one side appears on the other', async () => {
    const { alice, bob, rootId } = await connected();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'en direct'), index: 0 }));
    await settle();

    expect([...bob.values()].some((b) => b.text?.[0]?.text === 'en direct')).toBe(true);
  });

  it('both sides typing in one paragraph keeps both edits', async () => {
    const { alice, bob, rootId } = await connected();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'bonjour monde');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    await settle();

    alice.set(block.id, { ...alice.get(block.id)!, text: [{ text: 'bonjour cher monde' }] });
    bob.set(block.id, { ...bob.get(block.id)!, text: [{ text: 'bonjour monde !' }] });
    await settle();

    const text = (store: LoroBlockStore) => store.get(block.id)!.text!.map((r) => r.text).join('');
    expect(text(alice)).toBe(text(bob));
    expect(text(alice)).toContain('cher');
    expect(text(alice)).toContain('!');
  });

  it('an update is not echoed back and forth', async () => {
    // importing a peer's update fires the local change subscription too, and
    // sending it back would bounce the same bytes until one side gave up
    const { store: alice, rootId } = storeWithRoot();
    const bob = new LoroBlockStore();
    const [left, right] = loopback();

    let sent = 0;
    const counting = { ...left, send: (m: Uint8Array) => (sent++, left.send(m)) };
    connect(alice, counting);
    connect(bob, right);
    await settle();

    const before = sent;
    new Editor({ doc: { blocks: alice, rootId } }).dispatch((tx) =>
      tx.op({ type: 'insert_block', block: paragraph(rootId, 'x'), index: 0 }),
    );
    await settle();
    await settle();
    // one update out, and no storm: a bounce would keep climbing
    expect(sent - before).toBeLessThan(4);
  });

  it('stopping ends the flow', async () => {
    const { alice, bob, rootId, stop } = await connected();
    stop();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'après'), index: 0 }));
    await settle();
    expect([...bob.values()].some((b) => b.text?.[0]?.text === 'après')).toBe(false);
  });
});

describe('the protocol tolerates a stranger', () => {
  it('ignores a message kind it does not know', async () => {
    const { store, rootId } = storeWithRoot();
    const [left, right] = loopback();
    connect(store, left);
    // a newer peer speaking a kind we have not learned yet
    right.send(new Uint8Array([99, 1, 2, 3]));
    await settle();
    expect(store.has(rootId)).toBe(true);
  });

  it('treats an unreadable version vector as "send me everything"', async () => {
    const { store: alice, rootId } = storeWithRoot();
    const editor = new Editor({ doc: { blocks: alice, rootId } });
    const block = paragraph(rootId, 'tout');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    const [left, right] = loopback();
    connect(alice, left);
    let reply: Uint8Array | null = null;
    right.onMessage((m) => (reply = m));
    right.send(new Uint8Array([0, 255, 255, 255])); // a vector that will not decode
    await settle();

    expect(reply).not.toBeNull();
    const bob = new LoroBlockStore();
    bob.import(reply!.subarray(1));
    expect(bob.get(block.id)?.text?.[0]?.text).toBe('tout');
  });
});
