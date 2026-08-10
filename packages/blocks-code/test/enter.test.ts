// @vitest-environment happy-dom
//
// Enter, inside a code block. The key never splits the block — that is what
// makes the fence projection and the caret arithmetic agree — so everything it
// *does* do is this handler's, and none of it was covered: a new line came
// back to column zero, and `⌘⏎` did nothing at all.
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, plainText, textCaret, type BlockJSON } from '@nbe/core';
import { code } from '../src/dom';
import type { EditorView } from '@nbe/dom';

const CODE_ID = 'c1';

/** A document of one code block holding `text`, with the caret at `offset`. */
function editing(text: string, offset: number): { editor: Editor; view: EditorView } {
  const doc = docFromJSON({
    id: 'root',
    type: 'page',
    version: 1,
    children: [{ id: CODE_ID, type: 'code', version: 1, text: [{ text }] } as BlockJSON],
  });
  const editor = new Editor({ doc });
  editor.setSelection(textCaret(CODE_ID, offset));
  // the handler reads `editor` and re-asserts the DOM caret; there is no DOM
  // here, and the model is what these assert
  return { editor, view: { editor, syncDomSelection: () => {} } as unknown as EditorView };
}

/** Press Enter, with whatever modifiers, and report whether it was handled. */
function enter(view: EditorView, init: KeyboardEventInit = {}): boolean {
  const block = view.editor.doc.blocks.get(CODE_ID)!;
  const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init });
  const handler = code.view!.keys!['Enter']!;
  return (Array.isArray(handler) ? handler[0]! : handler)({ view, block, event }) === true;
}

const caret = (editor: Editor) => (editor.selection?.kind === 'text' ? editor.selection.head : null);

describe('a new line starts where the old one did', () => {
  it('keeps the indentation of the line it was pressed on', () => {
    const { editor, view } = editing('function f() {\n  const x = 1;', 29);
    expect(enter(view)).toBe(true);

    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('function f() {\n  const x = 1;\n  ');
    expect(caret(editor)?.offset).toBe(32);
  });

  it('goes one level deeper after a line that opens a block', () => {
    const { editor, view } = editing('function f() {', 14);
    enter(view);

    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('function f() {\n  ');
  });

  it('and after a colon, which is how the other half of the world opens one', () => {
    const { editor, view } = editing('def f():', 8);
    enter(view);

    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('def f():\n  ');
  });

  it('adds nothing at all on an unindented line', () => {
    const { editor, view } = editing('const x = 1;', 12);
    enter(view);

    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('const x = 1;\n');
  });

  it('leaves Shift+Enter to the editor, which spells "new line" the same way', () => {
    const { view } = editing('const x = 1;', 12);
    expect(enter(view, { shiftKey: true })).toBe(false);
  });
});

describe('Cmd/Ctrl+Enter leaves the block', () => {
  it('opens a paragraph under it and puts the caret there', () => {
    const { editor, view } = editing('const x = 1;', 12);
    expect(enter(view, { metaKey: true })).toBe(true);

    const children = editor.doc.blocks.get('root')!.children;
    expect(children.length).toBe(2);
    const paragraph = editor.doc.blocks.get(children[1]!)!;
    expect(paragraph.type).toBe('paragraph');
    expect(caret(editor)?.blockId).toBe(paragraph.id);
    // the code is untouched: this is a way out, not an edit
    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('const x = 1;');
  });

  it('works from the middle of the code, not just its end', () => {
    const { editor, view } = editing('un\ndeux\ntrois', 4);
    enter(view, { metaKey: true });

    expect(editor.doc.blocks.get('root')!.children.length).toBe(2);
    expect(plainText(editor.doc.blocks.get(CODE_ID)!.text)).toBe('un\ndeux\ntrois');
  });
});
