import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { plainText } from '../src/richtext';
import {
  deleteBlocks,
  duplicateBlocks,
  moveBlocksVertical,
  moveIntoColumns,
  selectedBlocks,
} from '../src/commands';
import type { Block } from '../src/types';

function seed(editor: Editor, id: string, text: string, type = 'paragraph', parentId?: string): Block {
  const pid = parentId ?? editor.doc.rootId;
  const b: Block = {
    id,
    type,
    version: 1,
    props: {},
    text: text ? [{ text }] : [],
    children: [],
    parentId: pid,
  };
  editor.dispatch(
    (tx) => tx.op({ type: 'insert_block', block: b, index: getBlock(editor.doc, pid).children.length }),
    { addToHistory: false },
  );
  return getBlock(editor.doc, id);
}

describe('columns + wrapper GC', () => {
  it('wraps target and dragged blocks into a column_list on side drop', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    moveIntoColumns(editor, ['b'], 'a', 'right');

    const root = getBlock(editor.doc, editor.doc.rootId);
    expect(root.children).toHaveLength(1);
    const list = getBlock(editor.doc, root.children[0]!);
    expect(list.type).toBe('column_list');
    expect(list.children).toHaveLength(2);
    const [colA, colB] = list.children.map((c) => getBlock(editor.doc, c));
    expect(colA!.type).toBe('column');
    expect(colA!.children).toEqual(['a']);
    expect(colB!.children).toEqual(['b']);
  });

  it('adds a column when dropping on a block already inside a column', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    seed(editor, 'c', 'c');
    moveIntoColumns(editor, ['b'], 'a', 'right');
    moveIntoColumns(editor, ['c'], 'a', 'left');

    const root = getBlock(editor.doc, editor.doc.rootId);
    const list = getBlock(editor.doc, root.children[0]!);
    expect(list.children).toHaveLength(3);
    expect(getBlock(editor.doc, list.children[0]!).children).toEqual(['c']);
  });

  it('GC dissolves the column_list when a column empties', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    moveIntoColumns(editor, ['b'], 'a', 'right');
    deleteBlocks(editor, ['b']);

    const root = getBlock(editor.doc, editor.doc.rootId);
    expect(root.children).toEqual(['a']);
    expect(getBlock(editor.doc, 'a').parentId).toBe(editor.doc.rootId);
    expect([...editor.doc.blocks.values()].filter((b) => b.type.startsWith('column'))).toHaveLength(0);
  });

  it('column creation and GC round-trip through undo', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    moveIntoColumns(editor, ['b'], 'a', 'right');
    editor.undo();
    const root = getBlock(editor.doc, editor.doc.rootId);
    expect(root.children).toEqual(['a', 'b']);
    expect([...editor.doc.blocks.values()].filter((b) => b.type.startsWith('column'))).toHaveLength(0);
    editor.redo();
    expect(getBlock(editor.doc, root.children[0]!).type).toBe('column_list');
  });
});

describe('block selection commands', () => {
  it('selectedBlocks normalizes to top blocks (subtrees implied)', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'a1', 'a1', 'paragraph', 'a');
    seed(editor, 'b', 'b');
    expect(selectedBlocks(editor.doc, { kind: 'block', anchor: 'a', head: 'b' })).toEqual(['a', 'b']);
    expect(selectedBlocks(editor.doc, { kind: 'block', anchor: 'a1', head: 'b' })).toEqual(['a1', 'b']);
  });

  it('deleteBlocks removes subtrees and places the caret on the previous block', () => {
    const editor = new Editor();
    seed(editor, 'a', 'aaa');
    seed(editor, 'b', 'b');
    seed(editor, 'b1', 'child', 'paragraph', 'b');
    deleteBlocks(editor, ['b']);
    expect(editor.doc.blocks.has('b')).toBe(false);
    expect(editor.doc.blocks.has('b1')).toBe(false);
    expect(editor.selection).toEqual({
      kind: 'text',
      anchor: { blockId: 'a', offset: 3 },
      head: { blockId: 'a', offset: 3 },
    });
    editor.undo();
    expect(editor.doc.blocks.has('b1')).toBe(true);
    expect(getBlock(editor.doc, 'b').children).toEqual(['b1']);
  });

  it('duplicateBlocks deep-clones with fresh ids after the selection', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello');
    seed(editor, 'a1', 'child', 'paragraph', 'a');
    const [dupId] = duplicateBlocks(editor, ['a']);
    const root = getBlock(editor.doc, editor.doc.rootId);
    expect(root.children).toHaveLength(2);
    const dup = getBlock(editor.doc, dupId!);
    expect(dup.id).not.toBe('a');
    expect(plainText(dup.text)).toBe('hello');
    expect(dup.children).toHaveLength(1);
    expect(plainText(getBlock(editor.doc, dup.children[0]!).text)).toBe('child');
    editor.undo();
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a']);
    editor.redo();
    expect(getBlock(editor.doc, editor.doc.rootId).children).toHaveLength(2);
  });

  it('moveBlocksVertical swaps within siblings and respects bounds', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    seed(editor, 'c', 'c');
    expect(moveBlocksVertical(editor, ['b'], 'up')).toBe(true);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['b', 'a', 'c']);
    expect(moveBlocksVertical(editor, ['b'], 'up')).toBe(false);
    expect(moveBlocksVertical(editor, ['a', 'c'], 'down')).toBe(false);
    expect(moveBlocksVertical(editor, ['a'], 'down')).toBe(true);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['b', 'c', 'a']);
  });
});
