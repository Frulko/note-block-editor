import { describe, expect, it } from 'vitest';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore } from '../src/store';
import { LoroHistory } from '../src/history';
import { connect, loopback } from '../src/sync';

/**
 * Document history.
 *
 * @remarks
 * The property that matters is not "a past version can be read" — it is that
 * restoring one **writes forward instead of rewinding**, so a peer holding
 * later changes converges on the restored document rather than reintroducing
 * what was undone.
 */

function editorOver(store: LoroBlockStore) {
  const rootId = uuidv7();
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  return { editor: new Editor({ doc: { blocks: store, rootId } }), rootId };
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

/**
 * The paragraphs in a store, sorted.
 *
 * @remarks
 * Sorted because `values()` walks the tree, and that order is not the
 * document's — asserting on it would be testing Loro's traversal rather than
 * our behaviour, and it would fail for a reason nobody cares about.
 */
const textsOf = (blocks: Block[]): string[] =>
  blocks
    .filter((block) => block.type === 'paragraph')
    .map((block) => (block.text ?? []).map((run) => run.text).join(''))
    .sort();

const texts = (store: LoroBlockStore): string[] => textsOf([...store.values()]);

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('a version can be named and found again', () => {
  it('lists checkpoints newest first, with their names', () => {
    const store = new LoroBlockStore();
    const history = new LoroHistory(store);
    const { editor, rootId } = editorOver(store);

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'premier'), index: 0 }));
    history.checkpoint('premier jet');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'second'), index: 1 }));
    history.checkpoint('avant refonte');

    const named = history.checkpoints().map((revision) => revision.message);
    expect(named).toContain('premier jet');
    expect(named).toContain('avant refonte');
  });

  it('reads the document as it was, without leaving it in the past', () => {
    const store = new LoroBlockStore();
    const history = new LoroHistory(store);
    const { editor, rootId } = editorOver(store);

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'seul'), index: 0 }));
    history.checkpoint('un seul bloc');
    const mark = history.checkpoints().find((r) => r.message === 'un seul bloc')!;

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'ajouté'), index: 1 }));

    expect(textsOf(history.readAt(mark.frontiers))).toEqual(['seul']);
    // and the document is back at the present, editable
    expect(texts(store)).toEqual(['ajouté', 'seul']);
  });
});

describe('restoring writes forward', () => {
  it('brings the old content back and keeps it in history', () => {
    const store = new LoroBlockStore();
    const history = new LoroHistory(store);
    const { editor, rootId } = editorOver(store);

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'à garder'), index: 0 }));
    history.checkpoint('bon état');
    const good = history.checkpoints().find((r) => r.message === 'bon état')!;

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'erreur'), index: 1 }));
    expect(texts(store)).toContain('erreur');

    history.restore(good.frontiers);

    expect(texts(store)).toEqual(['à garder']);
    // the restore is a version of its own, so it can itself be undone
    expect(history.checkpoints().map((r) => r.message)).toContain('Version restaurée');
  });

  it('a peer holding the discarded change converges, rather than resurrecting it', async () => {
    const [left, right] = loopback();
    const alice = new LoroBlockStore();
    const bob = new LoroBlockStore();
    const history = new LoroHistory(alice);
    const { editor, rootId } = editorOver(alice);

    connect(alice, left);
    connect(bob, right);
    await settle();

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'à garder'), index: 0 }));
    history.checkpoint('bon état');
    await settle();
    const good = history.checkpoints().find((r) => r.message === 'bon état')!;

    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'erreur'), index: 1 }));
    await settle();
    expect(texts(bob)).toContain('erreur');

    // this is the whole point: a rewind would be undone by Bob's next message
    history.restore(good.frontiers);
    await settle();

    expect(texts(alice)).toEqual(['à garder']);
    expect(texts(bob)).toEqual(['à garder']);
  });
});
