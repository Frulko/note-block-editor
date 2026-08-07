import { describe, expect, it } from 'vitest';
import { Editor, getBlock, insertText, textCaret, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore } from '../src/store';

/**
 * The document, backed by a CRDT.
 *
 * @remarks
 * The audit chose the CRDT as *the document* rather than as a transport beside
 * it, so the test is not "does it sync" — it is whether a real editor runs
 * against it unchanged. The seam only means something if the reducer cannot
 * tell the difference.
 *
 * The structure tests are the ones that matter most: a `Block` carries
 * `children` and `parentId`, the tree carries them too, and only one of the two
 * is allowed to be true.
 */

function editorOn(store: LoroBlockStore) {
  const rootId = uuidv7();
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  return new Editor({ doc: { blocks: store, rootId } });
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

describe('an editor runs on a CRDT without knowing', () => {
  it('inserts a block', () => {
    const editor = editorOn(new LoroBlockStore());
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([block.id]);
    expect(getBlock(editor.doc, block.id).type).toBe('paragraph');
  });

  it('types into one', () => {
    const editor = editorOn(new LoroBlockStore());
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.setSelection(textCaret(block.id, 0), 'api');
    insertText(editor, 'bonjour');
    expect(getBlock(editor.doc, block.id).text?.[0]?.text).toBe('bonjour');
  });

  it('undoes, since history is inverse ops rather than snapshots', () => {
    const editor = editorOn(new LoroBlockStore());
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.undo();
    expect(editor.doc.blocks.has(block.id)).toBe(false);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([]);
  });

  it('deletes a block and forgets it', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.dispatch((tx) => tx.op({ type: 'delete_block', id: block.id }));
    expect(store.has(block.id)).toBe(false);
    expect(store.size).toBe(1);
  });
});

describe('the tree owns the structure, and nothing else holds a copy', () => {
  it('a move reparents, in both directions of the relationship', () => {
    const editor = editorOn(new LoroBlockStore());
    const a = paragraph(editor.doc.rootId);
    const b = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => {
      tx.op({ type: 'insert_block', block: a, index: 0 });
      tx.op({ type: 'insert_block', block: b, index: 1 });
    });
    editor.dispatch((tx) => tx.op({ type: 'move_block', id: b.id, parentId: a.id, after: null }));

    expect(getBlock(editor.doc, a.id).children).toEqual([b.id]);
    expect(getBlock(editor.doc, b.id).parentId).toBe(a.id);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([a.id]);
  });

  it('sibling order follows the block, not the order things were created', () => {
    const editor = editorOn(new LoroBlockStore());
    const first = paragraph(editor.doc.rootId, 'un');
    const second = paragraph(editor.doc.rootId, 'deux');
    editor.dispatch((tx) => {
      tx.op({ type: 'insert_block', block: first, index: 0 });
      tx.op({ type: 'insert_block', block: second, index: 1 });
    });
    editor.dispatch((tx) => tx.op({ type: 'move_block', id: second.id, parentId: editor.doc.rootId, after: null }));
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([second.id, first.id]);
  });

  it('the parent of a root is null, derived from having no tree parent', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    expect(getBlock(editor.doc, editor.doc.rootId).parentId).toBeNull();
  });
});

describe('two peers converge', () => {
  /** Replicate a store's state into a fresh one, as a transport would. */
  function replicate(from: LoroBlockStore): LoroBlockStore {
    const to = new LoroBlockStore();
    to.import(from.export());
    return to;
  }

  it('a document survives being sent whole', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    const block = paragraph(editor.doc.rootId, 'partagé');
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));

    const other = replicate(store);
    expect(other.get(block.id)?.text?.[0]?.text).toBe('partagé');
    expect(other.get(editor.doc.rootId)?.children).toEqual([block.id]);
  });

  it('the same block moved on both sides does not become two blocks', () => {
    /*
     * The reason §3 made a move an *intent* rather than delete-plus-reinsert,
     * and the reason the audit wanted a movable tree: under
     * delete-and-reinsert this is where a block silently duplicates.
     */
    const alice = new LoroBlockStore();
    const editor = editorOn(alice);
    const parent = paragraph(editor.doc.rootId);
    const other = paragraph(editor.doc.rootId);
    const moving = paragraph(editor.doc.rootId, 'déplacé');
    editor.dispatch((tx) => {
      tx.op({ type: 'insert_block', block: parent, index: 0 });
      tx.op({ type: 'insert_block', block: other, index: 1 });
      tx.op({ type: 'insert_block', block: moving, index: 2 });
    });

    const bob = replicate(alice);
    // both move the same block, to different parents, without seeing each other
    alice.get(moving.id) && alice.set(moving.id, { ...alice.get(moving.id)!, parentId: parent.id });
    bob.get(moving.id) && bob.set(moving.id, { ...bob.get(moving.id)!, parentId: other.id });

    alice.import(bob.export());
    bob.import(alice.export());

    const inAlice = [...alice.values()].filter((b) => b.text?.[0]?.text === 'déplacé');
    const inBob = [...bob.values()].filter((b) => b.text?.[0]?.text === 'déplacé');
    expect(inAlice).toHaveLength(1);
    expect(inBob).toHaveLength(1);
    // and they agree on where it went
    expect(inAlice[0]!.parentId).toBe(inBob[0]!.parentId);
  });
});

describe('two people can type in the same paragraph', () => {
  /** Set up one paragraph, replicated to a second peer. */
  function pair(initial: string) {
    const alice = new LoroBlockStore();
    const editor = editorOn(alice);
    const block = paragraph(editor.doc.rootId, initial);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    const bob = new LoroBlockStore();
    bob.import(alice.export());
    return { alice, bob, blockId: block.id };
  }

  /** Type into a store the way the reducer does: hand it the finished runs. */
  function retype(store: LoroBlockStore, id: BlockId, text: string) {
    const block = store.get(id)!;
    store.set(id, { ...block, text: [{ text }] });
  }

  function sync(a: LoroBlockStore, b: LoroBlockStore) {
    a.import(b.export());
    b.import(a.export());
  }

  it('edits at different points in one line both survive', () => {
    const { alice, bob, blockId } = pair('bonjour monde');
    // stored as a value this is last-write-wins and one edit disappears
    retype(alice, blockId, 'bonjour cher monde');
    retype(bob, blockId, 'bonjour monde !');
    sync(alice, bob);

    const merged = alice.get(blockId)!.text!.map((run) => run.text).join('');
    expect(merged).toBe(bob.get(blockId)!.text!.map((run) => run.text).join(''));
    expect(merged).toContain('cher');
    expect(merged).toContain('!');
  });

  it('a deletion on one side and an insertion on the other both apply', () => {
    const { alice, bob, blockId } = pair('un deux trois');
    retype(alice, blockId, 'un trois');
    retype(bob, blockId, 'un deux trois quatre');
    sync(alice, bob);

    const merged = alice.get(blockId)!.text!.map((run) => run.text).join('');
    expect(merged).toBe(bob.get(blockId)!.text!.map((run) => run.text).join(''));
    expect(merged).toContain('quatre');
    expect(merged).not.toContain('deux');
  });

  it('marks survive a round trip', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    store.set(block.id, {
      ...store.get(block.id)!,
      text: [{ text: 'du ' }, { text: 'gras', marks: [{ type: 'bold' }] }, { text: ' ici' }],
    });

    const back = store.get(block.id)!.text!;
    expect(back.map((run) => run.text).join('')).toBe('du gras ici');
    expect(back.find((run) => run.text === 'gras')?.marks).toEqual([{ type: 'bold' }]);
  });

  it('a mark with attributes keeps them', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    store.set(block.id, {
      ...store.get(block.id)!,
      text: [{ text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }],
    });
    expect(store.get(block.id)!.text![0]!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com' } },
    ]);
  });

  it('removing a mark actually removes it', () => {
    const store = new LoroBlockStore();
    const editor = editorOn(store);
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    store.set(block.id, { ...store.get(block.id)!, text: [{ text: 'gras', marks: [{ type: 'bold' }] }] });
    // marking never clears what it does not name, so this is where a word
    // stays bold after the bold is switched off
    store.set(block.id, { ...store.get(block.id)!, text: [{ text: 'gras' }] });
    expect(store.get(block.id)!.text).toEqual([{ text: 'gras' }]);
  });
});
