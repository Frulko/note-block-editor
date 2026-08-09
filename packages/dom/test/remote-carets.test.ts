import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON } from '@nbe/core';
import { PEER_SLOTS, peerSelection } from '../src/remote-carets';

/**
 * Other people, made visible.
 *
 * @remarks
 * Every case here is a regression, not a hypothetical.
 *
 * A highlight registered under a name no stylesheet mentions is accepted by the
 * browser and paints nothing — no error, no warning. Every remote *selection*
 * was invisible that way, while the carets on top of them worked, which is why
 * it survived: the feature looked half-present rather than broken.
 *
 * And each host flattened the selection into presence itself, dropping it
 * whenever it crossed a block and publishing nothing at all for a block
 * selection. A peer disappeared from the other screens at the moment they were
 * doing the most visible thing in the document.
 */

const ui = readFileSync(join(__dirname, '..', 'src', 'style', 'ui.css'), 'utf8');

const editorWith = (): { editor: Editor; ids: [string, string] } => {
  const doc = docFromJSON({
    id: 'root',
    type: 'page',
    version: 1,
    props: {},
    children: [
      { id: 'a', type: 'paragraph', version: 1, props: {}, text: [{ text: 'premier' }], children: [] },
      { id: 'b', type: 'paragraph', version: 1, props: {}, text: [{ text: 'second' }], children: [] },
    ],
  });
  return { editor: new Editor({ doc }), ids: ['a', 'b'] };
};

describe('peer highlight slots', () => {
  it('has a ::highlight() rule for every slot the painter can take', () => {
    for (let slot = 0; slot < PEER_SLOTS; slot++) {
      expect(ui).toContain(`::highlight(nbe-peer-${slot})`);
    }
  });

  it('carries no rule for a slot the painter never reaches', () => {
    expect(ui).not.toContain(`::highlight(nbe-peer-${PEER_SLOTS})`);
  });
});

describe('peerSelection', () => {
  it('carries a caret as a collapsed range', () => {
    const { editor } = editorWith();
    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'a', offset: 3 } });
    expect(peerSelection(editor)).toEqual({ blockId: 'a', anchor: 3, head: 3 });
  });

  it('keeps the head block when the selection crosses one', () => {
    const { editor } = editorWith();
    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 4 } });
    expect(peerSelection(editor)).toEqual({ blockId: 'a', anchor: 1, head: 4, headBlockId: 'b' });
  });

  it('keeps a backwards selection backwards, so the caret lands on the head', () => {
    const { editor } = editorWith();
    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 6 }, head: { blockId: 'a', offset: 2 } });
    expect(peerSelection(editor)).toEqual({ blockId: 'a', anchor: 6, head: 2 });
  });

  it('expands a block selection into the blocks it holds', () => {
    const { editor } = editorWith();
    editor.setSelection({ kind: 'block', anchor: 'a', head: 'b' });
    expect(peerSelection(editor)).toEqual({ kind: 'blocks', ids: ['a', 'b'] });
  });

  it('publishes nothing when nobody is anywhere', () => {
    const { editor } = editorWith();
    editor.setSelection(null);
    expect(peerSelection(editor)).toBeNull();
  });
});
