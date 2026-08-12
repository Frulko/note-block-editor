import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { PluginRegistry, PLUGIN_API_VERSION } from '../src/plugin';
import { getBlock } from '../src/doc';
import { plainText } from '../src/richtext';
import {
  applyAutoformat,
  applyInlineFormat,
  indent,
  matchAutoformat,
  matchInlineFormat,
  matchTextReplacement,
  applyTextReplacement,
  mergeBackward,
  mergeForward,
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

describe('mergeForward', () => {
  it('pulls the next block in, promoting its children, caret unchanged', () => {
    const editor = new Editor();
    seed(editor, 'a', 'hello ');
    seed(editor, 'b', 'world', 'heading');
    seed(editor, 'b1', 'child', 'paragraph', 'b');
    editor.setSelection(textCaret('a', 6));
    expect(mergeForward(editor)).toBe(true);

    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello world');
    expect(editor.doc.blocks.has('b')).toBe(false);
    expect(getBlock(editor.doc, editor.doc.rootId).children).toEqual(['a', 'b1']);
    expect(editor.selection).toEqual(textCaret('a', 6));
    editor.undo();
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('hello ');
    expect(getBlock(editor.doc, 'b').children).toEqual(['b1']);
  });

  it('merges the first child into its parent (next visible block)', () => {
    const editor = new Editor();
    seed(editor, 'a', 'parent');
    seed(editor, 'a1', 'kid', 'paragraph', 'a');
    editor.setSelection(textCaret('a', 6));
    expect(mergeForward(editor)).toBe(true);
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('parentkid');
    expect(editor.doc.blocks.has('a1')).toBe(false);
  });

  it('block-selects a void next block instead of deleting it', () => {
    const editor = new Editor();
    seed(editor, 'a', 'x');
    seed(editor, 'd', '', 'divider');
    editor.setSelection(textCaret('a', 1));
    expect(mergeForward(editor)).toBe(true);
    expect(editor.doc.blocks.has('d')).toBe(true);
    expect(editor.selection).toEqual({ kind: 'block', anchor: 'd', head: 'd' });
  });

  it('does nothing mid-text or on the last block', () => {
    const editor = new Editor();
    seed(editor, 'a', 'xy');
    editor.setSelection(textCaret('a', 1));
    expect(mergeForward(editor)).toBe(false);
    editor.setSelection(textCaret('a', 2));
    expect(mergeForward(editor)).toBe(false);
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
    expect(matchAutoformat('#x ')).toBeNull();
    // ``` belongs to `@nbe/blocks-code` now: an unregistered plugin's shortcut
    // does nothing, which is the same rule as its block type not existing
    expect(matchAutoformat('```')).toBeNull();
  });

  it('lets a plugin claim a prefix of its own', () => {
    const plugins = new PluginRegistry().register({
      apiVersion: PLUGIN_API_VERSION,
      schema: { type: 'spoiler', version: 1, inline: true },
      autoformat: [{ prefix: '|| ', type: 'spoiler' }],
    });
    expect(matchAutoformat('|| ', plugins)?.type).toBe('spoiler');
    // and it is consulted first, so a plugin may override a built-in
    const shadow = new PluginRegistry().register({
      apiVersion: PLUGIN_API_VERSION,
      schema: { type: 'callout', version: 1, inline: true },
      autoformat: [{ prefix: '> ', type: 'callout' }],
    });
    expect(matchAutoformat('> ', shadow)?.type).toBe('callout');
    expect(matchAutoformat('> ')?.type).toBe('toggle');
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

describe('typographic replacement', () => {
  it('matches the longest pair ending at the caret', () => {
    expect(matchTextReplacement('on continue ->')?.text).toBe('→');
    expect(matchTextReplacement('a -->')?.text).toBe('⟶'); // not '-' + '→'
    expect(matchTextReplacement('x != y')).toBeNull(); // the pair must end at the caret
  });

  it('applies: swaps the pair, keeps its marks, undo restores the literal', () => {
    const editor = new Editor();
    seed(editor, 'a', 'go ->');
    editor.dispatch((tx) => tx.op({ type: 'format_text', id: 'a', from: 0, to: 5, mark: { type: 'bold' }, add: true }), { addToHistory: false });
    editor.setSelection(textCaret('a', 5));
    applyTextReplacement(editor, 'a', matchTextReplacement('go ->')!);
    expect(getBlock(editor.doc, 'a').text).toEqual([{ text: 'go →', marks: [{ type: 'bold' }] }]);
    expect(editor.selection).toEqual(textCaret('a', 4));
    editor.undo();
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('go ->');
  });
});

describe('inline autoformat', () => {
  it('matches the delimiter table', () => {
    expect(matchInlineFormat('say **bold**')?.mark.type).toBe('bold');
    expect(matchInlineFormat('say __bold__')?.mark.type).toBe('bold');
    expect(matchInlineFormat('say *ital*')?.mark.type).toBe('italic');
    expect(matchInlineFormat('say _ital_')?.mark.type).toBe('italic');
    expect(matchInlineFormat('say ~~gone~~')?.mark.type).toBe('strike');
    expect(matchInlineFormat('say `x = 1`')?.mark.type).toBe('code');
    expect(matchInlineFormat('see [docs](https://x.dev)')?.mark).toEqual({
      type: 'link',
      attrs: { href: 'https://x.dev' },
    });
  });

  it('rejects half-typed and prose look-alikes', () => {
    expect(matchInlineFormat('**bold*')).toBeNull(); // first closing star of **
    expect(matchInlineFormat('a * b * c')).toBeNull(); // spaced stars are prose
    expect(matchInlineFormat('snake_case_')).toBeNull(); // _ never opens mid-word
    expect(matchInlineFormat('**  **')).toBeNull(); // no whitespace-only content
    expect(matchInlineFormat('``')).toBeNull(); // empty code span
  });

  it('matches only the trailing span, not across a closed one', () => {
    const m = matchInlineFormat('**a** then **b**')!;
    expect(m.from).toBe(11);
    expect(m.to).toBe(16);
  });

  it('applies: strips delimiters, marks content, caret after content', () => {
    const editor = new Editor();
    seed(editor, 'a', 'say **bold**');
    editor.setSelection(textCaret('a', 12));
    applyInlineFormat(editor, 'a', matchInlineFormat('say **bold**')!);
    const a = getBlock(editor.doc, 'a');
    expect(a.text).toEqual([{ text: 'say ' }, { text: 'bold', marks: [{ type: 'bold' }] }]);
    expect(editor.selection).toEqual(textCaret('a', 8));
  });

  it('keeps marks already inside the span, and undo restores the literal text', () => {
    const editor = new Editor();
    seed(editor, 'a', '**a b**');
    editor.dispatch((tx) => tx.op({ type: 'format_text', id: 'a', from: 4, to: 5, mark: { type: 'italic' }, add: true }), { addToHistory: false });
    editor.setSelection(textCaret('a', 7));
    applyInlineFormat(editor, 'a', matchInlineFormat('**a b**')!);
    expect(getBlock(editor.doc, 'a').text).toEqual([
      { text: 'a ', marks: [{ type: 'bold' }] },
      { text: 'b', marks: [{ type: 'italic' }, { type: 'bold' }] },
    ]);
    editor.undo();
    expect(plainText(getBlock(editor.doc, 'a').text)).toBe('**a b**');
  });
});
