import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { uuidv7 } from '../src/id';
import type { Block } from '../src/types';

/**
 * What the schema does *not* check.
 *
 * @remarks
 * `schema.ts` carries a `ponytail:` note — "no allowedChildren grammar yet —
 * columns land with it" — and columns have landed. So the condition the note
 * set for itself is met, and the question is what the absence permits.
 *
 * This records the answer rather than assuming it, because "the schema
 * validates at apply" is a claim the architecture makes and a reader would take
 * to include structure.
 */

function block(type: string, parentId: string, props: Record<string, unknown> = {}): Block {
  return { id: uuidv7(), type, version: 1, props, children: [], parentId };
}

describe('structural grammar', () => {
  it('a column outside a column_list is accepted today', () => {
    /*
     * §2.3 makes `column` a child of `column_list` and nothing else — the
     * wrapper garbage collection in `editor.ts` assumes exactly that when it
     * dissolves underfull lists. A column parented to the page is therefore a
     * document no part of the system expects, and the schema lets it through.
     *
     * Not currently harmful: nothing constructs one, and the normaliser
     * dissolves empty columns wherever they sit. It is recorded because the
     * architecture says validation happens at apply, and a reader would take
     * that to include structure. It does not.
     */
    const editor = new Editor();
    const orphan = block('column', editor.doc.rootId);
    editor.dispatch(
      (tx) => tx.op({ type: 'insert_block', block: orphan, index: 0 }),
      { addToHistory: false },
    );
    expect(getBlock(editor.doc, orphan.id).type).toBe('column');
  });

  it('but an unknown block type is still rejected — the check that does exist', () => {
    // per-block validation at apply is real; it is *types* that are validated,
    // not the relationships between them
    const editor = new Editor();
    const alien = block('type-qui-nexiste-pas', editor.doc.rootId);
    expect(() =>
      editor.dispatch((tx) => tx.op({ type: 'insert_block', block: alien, index: 0 }), { addToHistory: false }),
    ).toThrow();
  });
});
