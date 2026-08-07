import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@nbe/core';
import { LoroBlockStore } from '../src/store';
import { connect, loopback } from '../src/sync';

/**
 * What happens when two peers each build their own document from the same file.
 *
 * @remarks
 * The tempting shortcut for putting an existing app on the CRDT: keep the JSON
 * as the thing on disk, and rebuild a fresh `LoroDoc` from it every time a page
 * opens. It looks free. This is the test that decides whether it is.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function seed(store: LoroBlockStore, rootId: string, ids: string[]): void {
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  for (const id of ids) {
    store.set(id, { id, type: 'paragraph', version: 1, props: {}, children: [], parentId: rootId, text: [{ text: id }] });
  }
  store.set(rootId, { ...store.get(rootId)!, children: ids });
}

describe('two documents built from the same file', () => {
  it('duplicate their contents when merged — so a snapshot must be shared instead', async () => {
    const rootId = uuidv7();
    const ids = [uuidv7(), uuidv7()];

    // both sides build their own CRDT from identical input
    const alice = new LoroBlockStore();
    const basile = new LoroBlockStore();
    seed(alice, rootId, ids);
    seed(basile, rootId, ids);

    const [left, right] = loopback();
    connect(alice, left);
    connect(basile, right);
    await settle();

    /*
     * Our block ids agree, but Loro's tree node ids do not — each peer created
     * its own nodes, and a CRDT is right to keep both. The document ends up
     * with every block twice.
     *
     * This is why the desktop app cannot simply rebuild a document from its
     * JSON on each open: the identity that matters to Loro is the node it
     * created, not the id we wrote inside it. Peers have to share one
     * *document* — a snapshot — not one *content*.
     */
    const paragraphs = [...alice.values()].filter((block) => block.type === 'paragraph');
    expect(paragraphs.length).toBeGreaterThan(ids.length);
  });

  it('agree when one snapshot is shared, which is the supported path', async () => {
    const rootId = uuidv7();
    const ids = [uuidv7(), uuidv7()];

    const alice = new LoroBlockStore();
    seed(alice, rootId, ids);

    // the second peer starts from the first's snapshot rather than from the file
    const basile = new LoroBlockStore();
    basile.import(alice.doc.export({ mode: 'snapshot' }));

    const [left, right] = loopback();
    connect(alice, left);
    connect(basile, right);
    await settle();

    const seen = (store: LoroBlockStore) =>
      [...store.values()].filter((block) => block.type === 'paragraph').map((block) => block.id).sort();
    expect(seen(alice)).toEqual(ids.slice().sort());
    expect(seen(basile)).toEqual(ids.slice().sort());
  });
});
