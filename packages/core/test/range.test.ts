import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { plainText } from '../src/richtext';
import { deleteTextSelection, rangeHasMark, resolveTextRange, toggleMarkRange } from '../src/commands';
import type { Block, TextSelection } from '../src/types';

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

const range = (a: string, ao: number, h: string, ho: number): TextSelection => ({
  kind: 'text',
  anchor: { blockId: a, offset: ao },
  head: { blockId: h, offset: ho },
});

function doc(): Editor {
  const editor = new Editor();
  seed(editor, 'a', 'premier bloc');
  seed(editor, 'b', 'deuxième bloc');
  seed(editor, 'c', 'troisième bloc');
  return editor;
}

describe('resolveTextRange', () => {
  it('orders a backwards selection and lists covered blocks', () => {
    const editor = doc();
    editor.setSelection(range('c', 3, 'a', 8));
    const r = resolveTextRange(editor)!;
    expect(r.startBlockId).toBe('a');
    expect(r.startOffset).toBe(8);
    expect(r.endBlockId).toBe('c');
    expect(r.endOffset).toBe(3);
    expect(r.blocks).toEqual(['a', 'b', 'c']);
    expect(r.single).toBe(false);
  });

  it('collapses to a single-block range when both ends share a block', () => {
    const editor = doc();
    editor.setSelection(range('b', 9, 'b', 2));
    const r = resolveTextRange(editor)!;
    expect(r.single).toBe(true);
    expect([r.startOffset, r.endOffset]).toEqual([2, 9]);
  });

  it('skips non-inline blocks when enumerating', () => {
    const editor = doc();
    seed(editor, 'd', '', 'divider');
    seed(editor, 'e', 'après');
    editor.setSelection(range('c', 0, 'e', 2));
    expect(resolveTextRange(editor)!.blocks).toEqual(['c', 'e']);
  });
});

describe('deleteTextSelection across blocks', () => {
  it('merges the remainder of the last block into the first', () => {
    const editor = doc();
    editor.setSelection(range('a', 7, 'c', 9));
    expect(deleteTextSelection(editor)).toBe(true);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('premier bloc');
    expect(editor.doc.blocks.has('b')).toBe(false);
    expect(editor.doc.blocks.has('c')).toBe(false);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a']);
    expect(editor.selection).toEqual(range('a', 7, 'a', 7));
  });

  it('keeps text on both sides of the range', () => {
    const editor = doc();
    editor.setSelection(range('a', 3, 'b', 8));
    deleteTextSelection(editor);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('pre bloc');
    expect(editor.doc.blocks.has('c')).toBe(true);
  });

  it('promotes the last block’s children instead of destroying them', () => {
    const editor = doc();
    seed(editor, 'c1', 'enfant', 'paragraph', 'c');
    editor.setSelection(range('a', 7, 'c', 9));
    deleteTextSelection(editor);
    expect(editor.doc.blocks.has('c1')).toBe(true);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a', 'c1']);
  });

  it('is a single undoable step that restores every block', () => {
    const editor = doc();
    editor.setSelection(range('a', 7, 'c', 9));
    deleteTextSelection(editor);
    expect(editor.undo()).toBe(true);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a', 'b', 'c']);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('premier bloc');
    expect(plainText(getBlock(editor.doc, 'c').text)).toBe('troisième bloc');
  });

  it('handles a whole-document range', () => {
    const editor = doc();
    editor.setSelection(range('a', 0, 'c', 14));
    deleteTextSelection(editor);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('');
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a']);
  });

  it('still deletes a plain single-block range', () => {
    const editor = doc();
    editor.setSelection(range('b', 0, 'b', 9));
    deleteTextSelection(editor);
    expect(plainText(getBlock(editor.doc, 'b').text)).toBe('bloc');
  });
});

describe('marks over a cross-block range', () => {
  it('applies the mark to the covered stretch of every block', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'c', 9));
    expect(toggleMarkRange(editor, 'bold')).toBe(true);
    expect(getBlock(editor.doc, 'a').text).toEqual([
      { text: 'premier ', marks: undefined },
      { text: 'bloc', marks: [{ type: 'bold' }] },
    ]);
    // the middle block is fully covered
    expect(getBlock(editor.doc, 'b').text).toEqual([{ text: 'deuxième bloc', marks: [{ type: 'bold' }] }]);
    expect(plainText(getBlock(editor.doc, 'c').text)).toBe('troisième bloc');
    expect(getBlock(editor.doc, 'c').text?.[0]?.marks).toEqual([{ type: 'bold' }]);
  });

  it('reports active only when the whole range carries the mark, and toggles off', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'c', 9));
    toggleMarkRange(editor, 'bold');
    expect(rangeHasMark(editor, 'bold')).toBe(true);
    // shrinking to an uncovered stretch is no longer fully bold
    editor.setSelection(range('a', 0, 'c', 9));
    expect(rangeHasMark(editor, 'bold')).toBe(false);
    editor.setSelection(range('a', 8, 'c', 9));
    toggleMarkRange(editor, 'bold');
    expect(rangeHasMark(editor, 'bold')).toBe(false);
    expect(getBlock(editor.doc, 'b').text).toEqual([{ text: 'deuxième bloc', marks: undefined }]);
  });

  it('is one undo step across all blocks', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'c', 9));
    toggleMarkRange(editor, 'bold');
    editor.undo();
    expect(getBlock(editor.doc, 'b').text).toEqual([{ text: 'deuxième bloc' }]);
  });
});
