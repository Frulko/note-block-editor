import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { uuidv7 } from '../src/id';
import type { Block } from '../src/types';

/**
 * Does a transaction get slower as the document grows?
 *
 * @remarks
 * `editor.ts` marks `normalizeWrappers` as a deliberate simplification: "full
 * scan per structural tx — fine at document scale, index later". The identical
 * shape in `Workspace` turned out to be quadratic and cost 33 seconds to build
 * ten thousand pages, so the note is worth checking rather than trusting.
 *
 * A ceiling that has been reached is a bug; one that has not is a good
 * decision. This says which.
 */

function insert(editor: Editor, text: string): void {
  const parentId = editor.doc.rootId;
  const block: Block = {
    id: uuidv7(),
    type: 'paragraph',
    version: 1,
    props: {},
    text: [{ text }],
    children: [],
    parentId,
  };
  editor.dispatch(
    (tx) => tx.op({ type: 'insert_block', block, index: getBlock(editor.doc, parentId).children.length }),
    { addToHistory: false },
  );
}

describe('a structural transaction at document scale', () => {
  it('costs about the same in a large document as in an empty one', () => {
    const editor = new Editor();
    const chunk = (n: number) => {
      const start = performance.now();
      for (let i = 0; i < n; i++) insert(editor, `ligne ${i}`);
      return performance.now() - start;
    };

    const first = chunk(200);
    for (let i = 0; i < 9; i++) chunk(200); // grow to ~2000 blocks
    const later = chunk(200);

    console.log(`insertion : 200 premières ${first.toFixed(0)}ms, 200 à ~2000 blocs ${later.toFixed(0)}ms`);
    /*
     * Wide tolerance: this catches a return to per-block work scaling with the
     * document, not a slow runner. Two thousand blocks is a long document — the
     * scale at which the survey says Notion starts to degrade.
     */
    expect(later).toBeLessThan(first * 6 + 30);
  });
});
