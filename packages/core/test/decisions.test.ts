import { describe, expect, it } from 'vitest';
import { createDoc, docFromJSON, docToJSON, type BlockJSON } from '../src/doc';
import { uuidv7 } from '../src/id';

/**
 * D5, D6 and D8 — the decision records that named no test.
 *
 * @remarks
 * D3, D4 and D7 each cite the suite that verifies them. These three did not,
 * and two of them are load-bearing: other code *relies* on D6's ordering
 * without saying so, and D5 is the shape every serialisation boundary assumes.
 */

describe('D5: a flat map at runtime, a nested tree at rest', () => {
  it('the nested form is genuinely nested, and the runtime form genuinely flat', () => {
    const nested: BlockJSON = {
      id: 'root',
      type: 'page',
      version: 1,
      children: [
        {
          id: 'a',
          type: 'toggle',
          version: 1,
          text: [{ text: 'parent' }],
          children: [{ id: 'b', type: 'paragraph', version: 1, text: [{ text: 'enfant' }] }],
        },
      ],
    };

    const doc = docFromJSON(nested);
    // flat at runtime: every block is a top-level entry, addressable by id
    // `BlockStore` deliberately exposes `values()` and not `keys()` — the six
    // members a Map already has, and no more
    expect([...doc.blocks.values()].map((block) => block.id).sort()).toEqual(['a', 'b', 'root']);
    expect(doc.blocks.get('b')!.parentId).toBe('a');
    // and structure lives in `children` arrays of ids, not in nesting
    expect(doc.blocks.get('a')!.children).toEqual(['b']);

    // nested at rest, and the two forms are the same document
    expect(docToJSON(doc)).toEqual(nested);
  });

  it('is not a real conflict: the round trip is exact both ways', () => {
    const doc = createDoc();
    expect(docToJSON(docFromJSON(docToJSON(doc)))).toEqual(docToJSON(doc));
  });
});

describe('D6: UUIDv7 — time-ordered, and still not a position', () => {
  it('a burst inside one millisecond is still ordered', () => {
    /*
     * The half that was false. Ten thousand ids minted as fast as possible land
     * in a handful of milliseconds, so almost all of the ordering comes from
     * the counter rather than the clock. Filling those bits with randomness —
     * as the first implementation did — shuffles them.
     */
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ids generated in sequence sort into creation order', () => {
    /*
     * Relied upon without saying so: `workspace/src/database.ts` sorts a
     * collection's rows by id and calls it creation order, and the index's
     * locality claim rests on the same property. If uuidv7 were not
     * time-ordered, rows would come back shuffled and nothing would fail loudly.
     */
    const ids = Array.from({ length: 200 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('still sorts correctly across a millisecond boundary', async () => {
    const before = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const after = uuidv7();
    expect(before < after).toBe(true);
  });

  it('is not sequential or positional — an id says when, never where', () => {
    // the other half of D6: time-ordered *yet non-positional*. Two ids a
    // millisecond apart must not be adjacent integers, or moving a block would
    // have to renumber its neighbours.
    const ids = Array.from({ length: 50 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // the random tail differs even for ids minted in the same millisecond
    const tails = new Set(ids.map((id) => id.slice(-12)));
    expect(tails.size).toBe(ids.length);
  });
});
