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
