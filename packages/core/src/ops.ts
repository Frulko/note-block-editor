import type { Block, BlockId, Run } from './types';
import type { Doc } from './doc';
import { getBlock } from './doc';
import { sliceRuns, spliceRuns, applyMark, textLength } from './richtext';

/**
 * The closed operation set (ARCHITECTURE §3). Every mutation flows through
 * these. Applying an op returns its exact inverse ops.
 */
export type Op =
  | { type: 'insert_block'; block: Block; index: number }
  | { type: 'delete_block'; id: BlockId } // block must have no children; delete bottom-up
  | { type: 'move_block'; id: BlockId; parentId: BlockId; after: BlockId | null }
  | { type: 'update_block'; id: BlockId; patch: { type?: string; props?: Record<string, unknown> } }
  | { type: 'insert_text'; id: BlockId; offset: number; runs: Run[] }
  | { type: 'delete_text'; id: BlockId; from: number; to: number }
  | { type: 'format_text'; id: BlockId; from: number; to: number; mark: { type: string; attrs?: Record<string, unknown> }; add: boolean };

export interface ApplyResult {
  inverse: Op[];
  dirty: BlockId[];
}

export function applyOp(doc: Doc, op: Op): ApplyResult {
  switch (op.type) {
    case 'insert_block': {
      const block = op.block;
      if (doc.blocks.has(block.id)) throw new Error(`insert_block: id exists: ${block.id}`);
      if (block.parentId === null) throw new Error('insert_block: cannot insert a root');
      const parent = getBlock(doc, block.parentId);
      doc.blocks.set(block.id, { ...block, children: [...block.children] });
      // subtree inserts: a parent inserted first already lists this child id
      if (!parent.children.includes(block.id)) parent.children.splice(op.index, 0, block.id);
      return { inverse: [{ type: 'delete_block', id: block.id }], dirty: [block.parentId, block.id] };
    }
    case 'delete_block': {
      const block = getBlock(doc, op.id);
      if (block.parentId === null) throw new Error('delete_block: cannot delete the root');
      // children may be listed in the array as long as their blocks are already
      // deleted from the map (bottom-up deletes, subtree-insert undo)
      if (block.children.some((c) => doc.blocks.has(c)))
        throw new Error('delete_block: block has children (delete bottom-up)');
      const parent = getBlock(doc, block.parentId);
      const index = parent.children.indexOf(op.id);
      parent.children.splice(index, 1);
      doc.blocks.delete(op.id);
      return { inverse: [{ type: 'insert_block', block, index }], dirty: [block.parentId, op.id] };
    }
    case 'move_block': {
      const block = getBlock(doc, op.id);
      if (block.parentId === null) throw new Error('move_block: cannot move the root');
      // reject cycles: the target parent must not be the block or its descendant
      // (bounded walk: even on corrupted state this must terminate)
      let probe: BlockId | null = op.parentId;
      for (let depth = 0; probe !== null && depth < 500; depth++) {
        if (probe === op.id) throw new Error('move_block: target is inside the moved block');
        probe = doc.blocks.get(probe)?.parentId ?? null;
      }
      if (probe !== null) throw new Error('move_block: ancestor chain too deep or cyclic');
      const oldParent = getBlock(doc, block.parentId);
      const oldIndex = oldParent.children.indexOf(op.id);
      const oldAfter = oldIndex > 0 ? oldParent.children[oldIndex - 1]! : null;
      oldParent.children.splice(oldIndex, 1);
      const newParent = getBlock(doc, op.parentId);
      const index = op.after === null ? 0 : newParent.children.indexOf(op.after) + 1;
      if (op.after !== null && index === 0) throw new Error(`move_block: after-sibling not found: ${op.after}`);
      newParent.children.splice(index, 0, op.id);
      const oldParentId = block.parentId;
      block.parentId = op.parentId;
      return {
        inverse: [{ type: 'move_block', id: op.id, parentId: oldParentId, after: oldAfter }],
        dirty: [oldParentId, op.parentId, op.id],
      };
    }
    case 'update_block': {
      const block = getBlock(doc, op.id);
      const inversePatch: { type?: string; props?: Record<string, unknown> } = {};
      if (op.patch.type !== undefined && op.patch.type !== block.type) {
        inversePatch.type = block.type;
        block.type = op.patch.type;
      }
      if (op.patch.props) {
        const prev: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(op.patch.props)) {
          prev[k] = block.props[k];
          if (v === undefined) delete block.props[k];
          else block.props[k] = v;
        }
        inversePatch.props = prev;
      }
      return { inverse: [{ type: 'update_block', id: op.id, patch: inversePatch }], dirty: [op.id] };
    }
    case 'insert_text': {
      const block = getBlock(doc, op.id);
      const runs = block.text ?? [];
      const len = textLength(op.runs);
      block.text = spliceRuns(runs, op.offset, op.offset, op.runs);
      return {
        inverse: [{ type: 'delete_text', id: op.id, from: op.offset, to: op.offset + len }],
        dirty: [op.id],
      };
    }
    case 'delete_text': {
      const block = getBlock(doc, op.id);
      const runs = block.text ?? [];
      const removed = sliceRuns(runs, op.from, op.to);
      block.text = spliceRuns(runs, op.from, op.to, []);
      return {
        inverse: [{ type: 'insert_text', id: op.id, offset: op.from, runs: removed }],
        dirty: [op.id],
      };
    }
    case 'format_text': {
      const block = getBlock(doc, op.id);
      const runs = block.text ?? [];
      const before = sliceRuns(runs, op.from, op.to);
      block.text = applyMark(runs, op.from, op.to, op.mark, op.add);
      // text is unchanged by formatting, so replace-with-old-slice is an exact inverse
      return {
        inverse: [
          { type: 'delete_text', id: op.id, from: op.from, to: op.to },
          { type: 'insert_text', id: op.id, offset: op.from, runs: before },
        ],
        dirty: [op.id],
      };
    }
  }
}
