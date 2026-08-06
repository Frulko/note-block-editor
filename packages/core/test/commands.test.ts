import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { plainText } from '../src/richtext';
import {
  applyAutoformat,
  indent,
  matchAutoformat,
  mergeBackward,
  outdent,
  splitBlock,
  toggleMark,
  turnInto,
} from '../src/commands';
import { textCaret } from '../src/types';
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

describe('splitBlock', () => {
  it('splits mid-text, moving the tail with its marks', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello world');
    editor.dispatch((tx) => tx.op({ type: 'format_text', id: 'a', from: 6, to: 11, mark: { type: 'bold' }, add: true }), { addToHistory: false });
    editor.setSelection(textCaret('a', 6));
    splitBlock(editor);

    const root = getBlock(editor.doc, editor.doc.rootId);
    expect(root.children).toHaveLength(2);
    const second = getBlock(editor.doc, root.children[1]!);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello ');
    expect(second.text).toEqual([{ text: 'world', marks: [{ type: 'bold' }] }]);
    expect(editor.selection).toEqual(textCaret(second.id, 0));
  });

  it('continues list types, converts empty list item to paragraph', () => {
    const editor = new Editor();
    seed(editor, 'a', 'item', 'bulleted_list_item');
    editor.setSelection(textCaret('a', 4));
    splitBlock(editor);
    const root = getBlock(editor.doc, editor.doc.rootId);
    const second = getBlock(editor.doc, root.children[1]!);
    expect(second.type).toBe('bulleted_list_item');

    // Enter on the now-empty list item converts it to a paragraph
    editor.setSelection(textCaret(second.id, 0));
    splitBlock(editor);
    expect(getBlock(editor.doc, second.id).type).toBe('paragraph');
    expect(getBlock(editor.doc, editor.doc.rootId).children).toHaveLength(2);
  });

  it('a full split+merge cycle is undoable back to the origin', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello world');
    editor.setSelection(textCaret('a', 6));
    splitBlock(editor);
    editor.undo();
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello world');
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a']);
  });
});

describe('mergeBackward', () => {
  it('converts non-paragraphs to paragraph first (Notion first-backspace)', () => {
    const editor = new Editor();
    seed(editor, 'a', 'title', 'heading');
    editor.setSelection(textCaret('a', 0));
    mergeBackward(editor);
    expect(getBlock(editor.doc, 'a').type).toBe('paragraph');
  });

  it('merges a paragraph into the previous block and promotes children', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello ');
    seed(editor, 'b', 'world');
    seed(editor, 'c', 'child', 'paragraph', 'b');
    editor.setSelection(textCaret('b', 0));
    mergeBackward(editor);

    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello world');
    expect(editor.doc.blocks.has('b')).toBe(false);
    // child promoted to where b was
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a', 'c']);
    expect(editor.selection).toEqual(textCaret('a', 6));
  });

  it('does nothing on the first block', () => {
    const editor = new Editor();
    seed(editor, 'a', 'x');
    editor.setSelection(textCaret('a', 0));
    expect(mergeBackward(editor)).toBe(false);
  });
});

describe('indent / outdent', () => {
  it('nests under previous sibling and back out', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    seed(editor, 'b', 'b');
    expect(indent(editor, 'b')).toBe(true);
    expect(getBlock(editor.doc, 'a').children).toEqual(['b']);
    expect(outdent(editor, 'b')).toBe(true);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a', 'b']);
  });

  it('first sibling cannot indent; top-level cannot outdent', () => {
    const editor = new Editor();
    seed(editor, 'a', 'a');
    expect(indent(editor, 'a')).toBe(false);
    expect(outdent(editor, 'a')).toBe(false);
  });
});

describe('toggleMark', () => {
  it('adds then removes a mark over the selection', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello');
    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 5 } });
    toggleMark(editor, 'bold');
    expect(getBlock(editor.doc, 'a').text).toEqual([{ text: 'hello', marks: [{ type: 'bold' }] }]);
    toggleMark(editor, 'bold');
    expect(getBlock(editor.doc, 'a').text).toEqual([{ text: 'hello', marks: undefined }]);
  });
});

describe('turnInto', () => {
  it('adds missing default props but never overwrites existing ones', () => {
    const editor = new Editor();
    seed(editor, 'a', 'task');
    editor.dispatch((tx) => tx.op({ type: 'update_block', id: 'a', patch: { props: { checked: true } } }), { addToHistory: false });
    turnInto(editor, 'a', 'to_do');
    expect(getBlock(editor.doc, 'a').type).toBe('to_do');
    expect(getBlock(editor.doc, 'a').props['checked']).toBe(true);
  });
});

describe('autoformat', () => {
  it('matches the rule table', () => {
    expect(matchAutoformat('# ')?.type).toBe('heading');
    expect(matchAutoformat('## ')?.props).toEqual({ level: 2 });
    expect(matchAutoformat('[] ')?.type).toBe('to_do');
    expect(matchAutoformat('> ')?.type).toBe('toggle');
    expect(matchAutoformat('```')?.type).toBe('code');
    expect(matchAutoformat('#x ')).toBeNull();
  });

  it('applies a rule: strips prefix, converts, caret at 0', () => {
    const editor = new Editor();
    seed(editor, 'a', '- ');
    editor.setSelection(textCaret('a', 2));
    applyAutoformat(editor, 'a', matchAutoformat('- ')!);
    const a = getBlock(editor.doc, 'a');
    expect(a.type).toBe('bulleted_list_item');
    expect(plainText(a.text)).toBe('');
    expect(editor.selection).toEqual(textCaret('a', 0));
  });
});
