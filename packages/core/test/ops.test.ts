import { describe, expect, it } from 'vitest';
import { createDoc, docToJSON, getBlock } from '../src/doc';
import { applyOp, type Op } from '../src/ops';
import type { Block, BlockId } from '../src/types';
import type { Doc } from '../src/doc';

let n = 0;
function block(doc: Doc, parentId: BlockId, text = '', index?: number): Block {
  const b: Block = {
    id: `b${n++}`,
    type: 'paragraph',
    version: 1,
    props: {},
    text: text ? [{ text }] : [],
    children: [],
    parentId,
  };
  applyOp(doc, { type: 'insert_block', block: b, index: index ?? getBlock(doc, parentId).children.length });
  return getBlock(doc, b.id);
}

function snapshot(doc: Doc): string {
  return JSON.stringify(docToJSON(doc));
}

function roundTrip(doc: Doc, op: Op): void {
  const before = snapshot(doc);
  const { inverse } = applyOp(doc, op);
  expect(snapshot(doc)).not.toBe(before);
  for (const inv of inverse) applyOp(doc, inv);
  expect(snapshot(doc)).toBe(before);
}

describe('ops apply + invert round-trips', () => {
  it('insert_block / delete_block', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId, 'hello');
    roundTrip(doc, { type: 'delete_block', id: a.id });
    roundTrip(doc, {
      type: 'insert_block',
      block: { id: 'x', type: 'paragraph', version: 1, props: {}, text: [], children: [], parentId: doc.rootId },
      index: 0,
    });
  });

  it('delete_block refuses non-leaf blocks', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId);
    block(doc, a.id);
    expect(() => applyOp(doc, { type: 'delete_block', id: a.id })).toThrow(/children/);
  });

  it('move_block with after-sibling semantics', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId, 'a');
    const b = block(doc, doc.rootId, 'b');
    const c = block(doc, doc.rootId, 'c');
    roundTrip(doc, { type: 'move_block', id: c.id, parentId: doc.rootId, after: null });
    roundTrip(doc, { type: 'move_block', id: a.id, parentId: b.id, after: null });
    applyOp(doc, { type: 'move_block', id: c.id, parentId: doc.rootId, after: a.id });
    expect(getBlock(doc, doc.rootId).children).toEqual([a.id, c.id, b.id]);
  });

  it('move_block rejects cycles', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId);
    const child = block(doc, a.id);
    expect(() =>
      applyOp(doc, { type: 'move_block', id: a.id, parentId: child.id, after: null }),
    ).toThrow(/inside/);
  });

  it('update_block patches type and props with exact inverse', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId);
    applyOp(doc, { type: 'update_block', id: a.id, patch: { props: { checked: true } } });
    roundTrip(doc, {
      type: 'update_block',
      id: a.id,
      patch: { type: 'heading', props: { level: 2, checked: undefined } },
    });
  });

  it('preserves unknown props through type changes (non-destructive turn-into)', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId);
    applyOp(doc, { type: 'update_block', id: a.id, patch: { props: { checked: true } } });
    applyOp(doc, { type: 'update_block', id: a.id, patch: { type: 'heading' } });
    expect(getBlock(doc, a.id).props['checked']).toBe(true);
  });

  it('insert_text / delete_text / format_text round-trips preserving marks', () => {
    const doc = createDoc();
    const a = block(doc, doc.rootId, 'hello world');
    applyOp(doc, { type: 'format_text', id: a.id, from: 0, to: 5, mark: { type: 'bold' }, add: true });
    roundTrip(doc, { type: 'insert_text', id: a.id, offset: 5, runs: [{ text: 'XX', marks: [{ type: 'italic' }] }] });
    roundTrip(doc, { type: 'delete_text', id: a.id, from: 3, to: 8 });
    roundTrip(doc, { type: 'format_text', id: a.id, from: 2, to: 9, mark: { type: 'italic' }, add: true });
  });
});
