import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { createDoc, getBlock, type BlockStore } from '../src/doc';
import { insertText, splitBlock } from '../src/commands';
import { textCaret, uuidv7 } from '../src/index';
import type { Block, BlockId } from '../src/types';

/**
 * The document store is an interface (phase 5).
 *
 * A seam nothing else implements is a seam in name only, so this drives a real
 * editor against a store that is not a `Map` — the shape a CRDT-backed or
 * lazily-materialising store would take. If this stops compiling or passing,
 * `Doc` has quietly grown a dependency on how its blocks are stored.
 */

/** A store that records every read, so we can see the editor using it. */
function countingStore(): BlockStore & { reads: number; writes: number } {
  const inner = new Map<BlockId, Block>();
  return {
    reads: 0,
    writes: 0,
    get(id) {
      this.reads++;
      return inner.get(id);
    },
    has: (id) => inner.has(id),
    set(id, block) {
      this.writes++;
      inner.set(id, block);
    },
    delete: (id) => inner.delete(id),
    values: () => inner.values(),
    get size() {
      return inner.size;
    },
  };
}

/** A document whose blocks live in the given store. */
function docWith(store: BlockStore) {
  const template = createDoc();
  for (const block of template.blocks.values()) store.set(block.id, block);
  return { blocks: store, rootId: template.rootId };
}

/**
 * A store that hands out *copies*, so mutating what you read writes nowhere.
 *
 * @remarks
 * This is what a CRDT-backed or lazily-materialising store looks like, and it
 * is the reason declaring `BlockStore` was not enough on its own: the reducer
 * mutated the object `get` returned and never wrote it back, which only worked
 * because a `Map` hands out its own object. Against this store, any missing
 * write-back is a lost edit.
 */
function copyingStore(): BlockStore {
  const inner = new Map<BlockId, Block>();
  const clone = (block: Block): Block => structuredClone(block);
  return {
    get: (id) => {
      const found = inner.get(id);
      return found ? clone(found) : undefined;
    },
    has: (id) => inner.has(id),
    set: (id, block) => void inner.set(id, clone(block)),
    delete: (id) => inner.delete(id),
    values: () => [...inner.values()].map(clone).values(),
    get size() {
      return inner.size;
    },
  };
}

describe('a store that hands out copies still sees every edit', () => {
  const paragraph = (parentId: BlockId): Block => ({
    id: uuidv7(),
    type: 'paragraph',
    version: 1,
    props: {},
    children: [],
    parentId,
    text: [],
  });

  it('an insert reaches the parent, whose children array was mutated in place', () => {
    const editor = new Editor({ doc: docWith(copyingStore()) });
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([block.id]);
  });

  it('typed text survives, though `block.text` was assigned in place', () => {
    const editor = new Editor({ doc: docWith(copyingStore()) });
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.setSelection(textCaret(block.id, 0), 'api');
    insertText(editor, 'bonjour');
    expect(getBlock(editor.doc, block.id).text?.[0]?.text).toBe('bonjour');
  });

  it('a move reaches both parents and the block', () => {
    const editor = new Editor({ doc: docWith(copyingStore()) });
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

  it('a type change reaches the block', () => {
    const editor = new Editor({ doc: docWith(copyingStore()) });
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.dispatch((tx) => tx.op({ type: 'update_block', id: block.id, patch: { type: 'quote' } }));
    expect(getBlock(editor.doc, block.id).type).toBe('quote');
  });

  it('undo reaches it too', () => {
    const editor = new Editor({ doc: docWith(copyingStore()) });
    const block = paragraph(editor.doc.rootId);
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }));
    editor.undo();
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual([]);
  });
});

describe('an editor runs against any store', () => {
  it('accepts one that is not a Map', () => {
    const store = countingStore();
    const editor = new Editor({ doc: docWith(store) });
    expect(getBlock(editor.doc, editor.doc.rootId).type).toBe('page');
    expect(store.reads).toBeGreaterThan(0);
  });

  it('inserts, splits and reads back through it', () => {
    const store = countingStore();
    const editor = new Editor({ doc: docWith(store) });

    const paragraph: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      children: [],
      parentId: editor.doc.rootId,
      text: [],
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph, index: 0 }));
    editor.setSelection(textCaret(paragraph.id, 0), 'api');
    insertText(editor, 'bonjour tout le monde');
    expect(getBlock(editor.doc, paragraph.id).text?.[0]?.text).toBe('bonjour tout le monde');

    editor.setSelection(textCaret(paragraph.id, 7), 'api');
    splitBlock(editor);
    expect(store.writes).toBeGreaterThan(1);
    expect([...editor.doc.blocks.values()].filter((b) => b.type === 'paragraph')).toHaveLength(2);
  });

  it('undo works through it, since history is ops rather than snapshots', () => {
    const store = countingStore();
    const editor = new Editor({ doc: docWith(store) });
    const paragraph: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      children: [],
      parentId: editor.doc.rootId,
      text: [],
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph, index: 0 }));
    expect(editor.doc.blocks.has(paragraph.id)).toBe(true);
    editor.undo();
    expect(editor.doc.blocks.has(paragraph.id)).toBe(false);
  });

  it('a Map still satisfies it, so nothing had to change', () => {
    const plain = createDoc();
    const asStore: BlockStore = plain.blocks;
    expect(asStore.size).toBe(1);
  });
});
