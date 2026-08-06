import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { plainText } from '../src/richtext';
import { insertText, deleteBackward } from '../src/commands';
import { textCaret } from '../src/types';
import type { Block } from '../src/types';

function seed(editor: Editor, id: string, text: string): Block {
  const b: Block = {
    id,
    type: 'paragraph',
    version: 1,
    props: {},
    text: text ? [{ text }] : [],
    children: [],
    parentId: editor.doc.rootId,
  };
  editor.dispatch(
    (tx) => tx.op({ type: 'insert_block', block: b, index: getBlock(editor.doc, editor.doc.rootId).children.length }),
    { addToHistory: false },
  );
  return getBlock(editor.doc, id);
}

describe('editor history', () => {
  it('undoes and redoes a transaction, restoring selection', () => {
    const editor = new Editor();
    const a = seed(editor, 'a', 'hello');
    editor.setSelection(textCaret('a', 5));
    insertText(editor, '!');
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello!');

    expect(editor.undo()).toBe(true);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello');
    expect(editor.selection).toEqual(textCaret('a', 5));

    expect(editor.redo()).toBe(true);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello!');
    expect(editor.selection).toEqual(textCaret('a', 6));
    expect(a.id).toBe('a');
  });

  it('coalesces rapid typing into one undo group', () => {
    const editor = new Editor();
    seed(editor, 'a', '');
    editor.setSelection(textCaret('a', 0));
    for (const ch of 'hey') insertText(editor, ch);
    expect(editor.undoDepth).toBe(1);
    editor.undo();
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('');
  });

  it('does not coalesce across different blocks', () => {
    const editor = new Editor();
    seed(editor, 'a', '');
    seed(editor, 'b', '');
    editor.setSelection(textCaret('a', 0));
    insertText(editor, 'x');
    editor.setSelection(textCaret('b', 0));
    insertText(editor, 'y');
    expect(editor.undoDepth).toBe(2);
  });

  it('clears the redo stack on a new edit', () => {
    const editor = new Editor();
    seed(editor, 'a', '');
    editor.setSelection(textCaret('a', 0));
    insertText(editor, 'x');
    editor.undo();
    editor.setSelection(textCaret('a', 0));
    insertText(editor, 'z');
    expect(editor.redoDepth).toBe(0);
  });

  it('deleteBackward steps over surrogate pairs', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a😀');
    editor.setSelection(textCaret('a', 3));
    deleteBackward(editor);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('a');
  });

  it('rejects unknown block types at dispatch', () => {
    const editor = new Editor();
    expect(() =>
      editor.dispatch((tx) =>
        tx.op({
          type: 'insert_block',
          block: { id: 'x', type: 'nope', version: 1, props: {}, children: [], parentId: editor.doc.rootId },
          index: 0,
        }),
      ),
    ).toThrow(/Unknown block type/);
  });
});
