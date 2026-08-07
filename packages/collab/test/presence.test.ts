import { describe, expect, it } from 'vitest';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore } from '../src/store';
import { connect, loopback } from '../src/sync';
import { createPresence } from '../src/presence';

/**
 * Cursors, which are not edits.
 *
 * §3 says ephemeral overlay state never enters the document or history. So the
 * tests that matter are the ones proving it stays out: a remote caret must not
 * be undoable, must not be saved, and must not outlive the person who left.
 */

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('peers see each other', () => {
  it('an announcement reaches the other side', async () => {
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice' });
    const bob = createPresence(right, { id: 'bob' });

    alice.set({ name: 'Alice', selection: { blockId: 'b1', anchor: 0, head: 4 } });
    await settle();

    expect(bob.peers()['alice']?.name).toBe('Alice');
    expect(bob.peers()['alice']?.selection).toEqual({ blockId: 'b1', anchor: 0, head: 4 });
  });

  it('a peer never sees itself', async () => {
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice' });
    createPresence(right, { id: 'bob' });
    alice.set({ name: 'Alice' });
    await settle();
    expect(alice.peers()['alice']).toBeUndefined();
  });

  it('a later announcement replaces the earlier one', async () => {
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice' });
    const bob = createPresence(right, { id: 'bob' });

    alice.set({ selection: { blockId: 'b1', anchor: 0, head: 0 } });
    await settle();
    alice.set({ selection: { blockId: 'b2', anchor: 3, head: 3 } });
    await settle();

    expect(bob.peers()['alice']?.selection).toEqual({ blockId: 'b2', anchor: 3, head: 3 });
  });

  it('a change notifies listeners', async () => {
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice' });
    const bob = createPresence(right, { id: 'bob' });

    const seen: number[] = [];
    bob.onChange((peers) => seen.push(Object.keys(peers).length));
    alice.set({ name: 'Alice' });
    await settle();

    expect(seen.at(-1)).toBe(1);
  });
});

describe('a peer that vanishes is forgotten', () => {
  it('leaving removes it', async () => {
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice' });
    const bob = createPresence(right, { id: 'bob' });
    alice.set({ name: 'Alice' });
    await settle();
    expect(Object.keys(bob.peers())).toEqual(['alice']);

    alice.leave();
    await settle();
    expect(bob.peers()['alice']).toBeUndefined();
  });

  it('so does a peer that never says goodbye', async () => {
    // a closed tab, a sleeping laptop, a dropped network: no farewell arrives,
    // and a presence keyed on disconnection would leave a ghost forever
    const [left, right] = loopback();
    const alice = createPresence(left, { id: 'alice', timeoutMs: 40 });
    const bob = createPresence(right, { id: 'bob', timeoutMs: 40 });
    alice.set({ name: 'Alice' });
    await settle();
    expect(Object.keys(bob.peers())).toEqual(['alice']);

    await settle(120); // Alice stops refreshing, without leaving
    expect(bob.peers()['alice']).toBeUndefined();
  });
});

describe('presence never touches the document', () => {
  it('sharing a socket does not put a cursor in the document', async () => {
    const store = new LoroBlockStore();
    const rootId = uuidv7();
    store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });

    const other = new LoroBlockStore();
    const [left, right] = loopback();
    connect(store, left);
    connect(other, right);
    const alice = createPresence(left, { id: 'alice' });
    await settle();

    const before = store.size;
    alice.set({ selection: { blockId: rootId, anchor: 0, head: 0 } });
    await settle();

    // the document is exactly what it was: a caret is not an edit
    expect(store.size).toBe(before);
    expect(other.size).toBe(before);
  });

  it('a cursor is not undoable, because it was never a transaction', async () => {
    const store = new LoroBlockStore();
    const rootId = uuidv7();
    store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
    const editor = new Editor({ doc: { blocks: store, rootId } });

    const block: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      children: [],
      parentId: rootId,
      text: [{ text: 'écrit' }],
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    const [left] = loopback();
    createPresence(left, { id: 'alice' }).set({ selection: { blockId: block.id, anchor: 0, head: 5 } });
    await settle();

    // one undo removes the paragraph: nothing was pushed on top of it
    editor.undo();
    expect(store.has(block.id as BlockId)).toBe(false);
  });

  it('the document and presence do not read each other messages', async () => {
    const store = new LoroBlockStore();
    const rootId = uuidv7();
    store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
    const [left, right] = loopback();
    connect(store, left);
    const bob = createPresence(right, { id: 'bob' });

    // a document update goes past presence without confusing it
    const editor = new Editor({ doc: { blocks: store, rootId } });
    editor.dispatch((tx) =>
      tx.op({
        type: 'insert_block',
        block: { id: uuidv7(), type: 'paragraph', version: 1, props: {}, children: [], parentId: rootId, text: [] },
        index: 0,
      }),
    );
    await settle();
    expect(Object.keys(bob.peers())).toEqual([]);
  });
});
