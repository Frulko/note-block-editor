// @vitest-environment happy-dom
//
// A line with nothing on it gets no caret: measured in Chromium, a collapsed
// range at the start of an empty line reports a zero-height box, so the browser
// draws nothing. Pressing Enter in a code block therefore opened a line and
// left the caret nowhere — "Enter adds a gap instead of a line".
//
// The sentinel is what the browser can draw on. What is asserted here is the
// contract that keeps it out of everything else: it is DOM, and the model has
// never heard of it. Written against paragraphs — a code block needs its
// plugin, and the leaf is rendered the same way for both.
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, plainText, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { EMPTY_LINE, leafText } from '../src/topology';
import { domToModelPoint, modelPointToDom } from '../src/selection';

/** A one-block document holding `text`, mounted. */
function mount(text: string): { view: EditorView; leaf: HTMLElement; id: string } {
  const container = document.createElement('div');
  document.body.append(container);
  const doc = docFromJSON({
    id: 'root',
    type: 'page',
    version: 1,
    children: [{ id: 'b1', type: 'paragraph', version: 1, text: [{ text }] } as BlockJSON],
  });
  const view = new EditorView(container, new Editor({ doc }));
  return { view, leaf: view.leafEl('b1')!, id: 'b1' };
}

describe('every empty line carries a sentinel', () => {
  it('puts one on a trailing empty line', () => {
    const { leaf } = mount('un\n');
    expect([...leaf.childNodes].map((n) => n.textContent)).toEqual(['un\n', EMPTY_LINE]);
  });

  it('puts one on an empty line in the middle', () => {
    const { leaf } = mount('un\n\ntrois');
    expect([...leaf.childNodes].map((n) => n.textContent)).toEqual(['un\n', EMPTY_LINE, '\ntrois']);
  });

  it('puts one on each of several in a row', () => {
    const { leaf } = mount('un\n\n\n');
    expect([...leaf.childNodes].map((n) => n.textContent).filter((t) => t === EMPTY_LINE)).toHaveLength(3);
  });

  it('leaves a block with no empty line alone', () => {
    const { leaf } = mount('un\ndeux');
    expect([...leaf.childNodes].map((n) => n.textContent)).toEqual(['un\ndeux']);
  });
});

describe('the sentinel is DOM, never model', () => {
  it('is not in the text the model is compared against', () => {
    const { view, leaf } = mount('un\n\ntrois');
    expect(leaf.textContent).toContain(EMPTY_LINE);
    expect(leafText(leaf)).toBe(plainText(view.editor.doc.blocks.get('b1')!.text));
  });

  it('costs no offset: a point after it maps to the model offset of the line', () => {
    const { leaf } = mount('un\n\ntrois');
    const sentinel = [...leaf.childNodes].find((n) => n.textContent === EMPTY_LINE)!;
    // both ends of the sentinel are the same place in the model — the start of
    // the empty line, which is offset 3 in "un\n\ntrois"
    expect(domToModelPoint(sentinel, 0)?.offset).toBe(3);
    expect(domToModelPoint(sentinel, 1)?.offset).toBe(3);
  });

  it('maps offsets after it as if it were not there', () => {
    const { leaf } = mount('un\n\ntrois');
    const tail = leaf.childNodes[2]!; // "\ntrois"
    expect(domToModelPoint(tail, 3)?.offset).toBe(6); // "un\n\ntr"
  });
});

describe('the caret aims at the sentinel, because it is the drawable one', () => {
  it('lands in it rather than at the invisible end of the line above', () => {
    const { view, leaf } = mount('un\n\ntrois');
    const at = modelPointToDom(view, { blockId: 'b1', offset: 3 })!;
    expect(at.node).toBe([...leaf.childNodes].find((n) => n.textContent === EMPTY_LINE));
    expect(at.offset).toBe(0);
  });

  it('does the same at the end of a text that ends on a newline', () => {
    const { view, leaf } = mount('un\n');
    const at = modelPointToDom(view, { blockId: 'b1', offset: 3 })!;
    expect(at.node).toBe(leaf.childNodes[1]);
  });

  it('still lands in the text for an ordinary offset', () => {
    const { view, leaf } = mount('un\n\ntrois');
    const at = modelPointToDom(view, { blockId: 'b1', offset: 5 })!;
    expect(at.node).toBe(leaf.childNodes[2]); // "\ntrois", which starts at model offset 3
    expect(at.offset).toBe(2);
  });

  it('round-trips every offset of a block full of empty lines', () => {
    const text = 'un\n\n\ndeux\n';
    const { view } = mount(text);
    for (let offset = 0; offset <= text.length; offset++) {
      const at = modelPointToDom(view, { blockId: 'b1', offset })!;
      expect(domToModelPoint(at.node, at.offset)?.offset, `offset ${offset}`).toBe(offset);
    }
  });
});
