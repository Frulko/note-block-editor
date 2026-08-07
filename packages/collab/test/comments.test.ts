import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { newMessage, newThread } from '@nbe/core';
import { LoroComments } from '../src/comments';
import { LoroBlockStore } from '../src/store';
import { connect, loopback } from '../src/sync';

/**
 * Comments across two peers.
 *
 * @remarks
 * The behaviour worth protecting is the one a plain array would lose: two
 * people replying to the same thread at the same moment, with neither reply
 * overwriting the other. Everything else here is bookkeeping.
 */

/** Settle the asynchronous loopback. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('comments merge between peers', () => {
  it('a thread created on one side arrives on the other', async () => {
    const [left, right] = loopback();
    const a = new LoroDoc();
    const b = new LoroDoc();
    connect(new LoroBlockStore(a), left);
    connect(new LoroBlockStore(b), right);

    const alice = new LoroComments(a);
    const thread = newThread(newMessage('alice', 'on reformule ?'), 'bloc-1');
    alice.create(thread);
    await settle();

    const seen = new LoroComments(b).get(thread.id);
    expect(seen?.messages.map((m) => m.body)).toEqual(['on reformule ?']);
    expect(seen?.blockId).toBe('bloc-1');
  });

  it('two replies written at the same moment both survive', async () => {
    const [left, right] = loopback();
    const a = new LoroDoc();
    const b = new LoroDoc();
    const alice = new LoroComments(a);
    const bob = new LoroComments(b);

    const thread = newThread(newMessage('alice', 'question'));
    alice.create(thread);
    b.import(a.export({ mode: 'snapshot' }));

    connect(new LoroBlockStore(a), left);
    connect(new LoroBlockStore(b), right);

    // neither has seen the other's reply when it is written
    alice.addMessage(thread.id, newMessage('alice', "d'Alice"));
    bob.addMessage(thread.id, newMessage('bob', 'de Bob'));
    await settle();

    const fromA = alice.get(thread.id)!.messages.map((m) => m.body);
    const fromB = bob.get(thread.id)!.messages.map((m) => m.body);
    expect(fromA).toHaveLength(3);
    expect(fromA).toEqual(expect.arrayContaining(["d'Alice", 'de Bob']));
    // and both peers agree on the order, not merely on the contents
    expect(fromA).toEqual(fromB);
  });

  it('resolving on one side shows on the other', async () => {
    const [left, right] = loopback();
    const a = new LoroDoc();
    const b = new LoroDoc();
    const alice = new LoroComments(a);
    connect(new LoroBlockStore(a), left);
    connect(new LoroBlockStore(b), right);

    const thread = newThread(newMessage('alice', 'à revoir'));
    alice.create(thread);
    await settle();
    alice.setResolved(thread.id, true);
    await settle();

    expect(new LoroComments(b).get(thread.id)?.resolved).toBe(true);
  });

  it('a deletion propagates rather than reappearing', async () => {
    const [left, right] = loopback();
    const a = new LoroDoc();
    const b = new LoroDoc();
    const alice = new LoroComments(a);
    connect(new LoroBlockStore(a), left);
    connect(new LoroBlockStore(b), right);

    const thread = newThread(newMessage('alice', 'erreur de ma part'));
    alice.create(thread);
    await settle();
    alice.delete(thread.id);
    await settle();

    expect(new LoroComments(b).get(thread.id)).toBeUndefined();
    expect(new LoroComments(b).list()).toEqual([]);
  });
});

describe('the panel is not woken by typing', () => {
  it('onChange fires for a comment and not for a block edit', () => {
    const doc = new LoroDoc();
    const comments = new LoroComments(doc);
    const blocks = new LoroBlockStore(doc);

    let fired = 0;
    comments.onChange(() => fired++);

    blocks.set('b1', { id: 'b1', type: 'paragraph', version: 1, props: {}, children: [], parentId: null });
    expect(fired).toBe(0);

    comments.create(newThread(newMessage('alice', 'ici')));
    expect(fired).toBe(1);
  });
});
