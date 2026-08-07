import type { Block } from './types';
import type { Doc } from './doc';
import type { Schema } from './schema';
import { blockCategory } from './schema';

/**
 * Per-block validation at apply.
 *
 * @remarks
 * `applyOp` already refuses structurally impossible operations — inserting a
 * duplicate id, inserting a second root. What it never did is consult the
 * *schema*, so a block could enter the document in a shape its own type
 * forbids and only fail much later, in a renderer or a projection, far from
 * the transaction that caused it.
 *
 * What this deliberately does **not** do is validate props against a type
 * declaration, because `BlockSpec` has no prop schema — only `defaultProps`.
 * Inventing one here would be a large speculative surface; a block that wants
 * prop checking can bring its own {@link BlockSpec.validate}.
 *
 * @category Blocks
 */

export interface Violation {
  blockId: string;
  type: string;
  message: string;
}

/**
 * Check one block against its spec.
 *
 * @param schema - The registry to check against.
 * @param block - The block as it would enter the document.
 * @param doc - The document, for relationships a block alone cannot answer.
 * @returns Every problem found. Empty means valid.
 *
 * @category Blocks
 */
export function validateBlock(schema: Schema, block: Block, doc?: Doc): Violation[] {
  const out: Violation[] = [];
  const fail = (message: string) => out.push({ blockId: block.id, type: block.type, message });

  if (!schema.has(block.type)) {
    // not a violation: an unloaded plugin's block is preserved by design, and
    // the load path reports it separately. Nothing further can be checked.
    return out;
  }
  const spec = schema.get(block.type);
  const category = blockCategory(schema, block.type);

  if (!spec.inline && block.text?.length) {
    // a void block's text is invisible in the editor and silently dropped by
    // every projection — exactly the kind of loss that must fail loudly
    fail(`type "${block.type}" carries no inline text, but text was set`);
  }
  if (block.version > spec.version) {
    fail(`version ${block.version} is newer than the schema's ${spec.version}`);
  }
  if (block.version < 1) {
    fail(`version must be at least 1, got ${block.version}`);
  }
  if (category === 'layout' && block.children.length === 0 && block.parentId !== null) {
    // an empty layout container renders as nothing and traps the caret; the
    // reducer's normalization removes them, so seeing one means normalization
    // was bypassed
    fail(`layout block "${block.type}" has no children`);
  }
  if (doc) {
    for (const childId of block.children) {
      if (!doc.blocks.has(childId)) fail(`child "${childId}" is not in the document`);
    }
    if (block.parentId !== null && !doc.blocks.has(block.parentId)) {
      fail(`parent "${block.parentId}" is not in the document`);
    }
  }

  out.push(...(spec.validate?.(block) ?? []).map((message) => ({ blockId: block.id, type: block.type, message })));
  return out;
}

/**
 * Check every block in a document.
 *
 * @remarks
 * Linear in document size, so this is a debugging and test tool rather than
 * something to run per transaction. {@link validateBlock} on the blocks a
 * transaction touched is the per-apply path.
 *
 * @category Blocks
 */
export function validateDoc(schema: Schema, doc: Doc): Violation[] {
  return [...doc.blocks.values()].flatMap((b) => validateBlock(schema, b, doc));
}

/** How a violation is surfaced. */
export type ValidationMode = 'off' | 'warn' | 'throw';

export class ValidationError extends Error {
  constructor(readonly violations: Violation[]) {
    super(
      `Invalid block${violations.length > 1 ? 's' : ''}: ` +
        violations.map((v) => `${v.type}#${v.blockId}: ${v.message}`).join('; '),
    );
    this.name = 'ValidationError';
  }
}

/**
 * Apply the configured reaction to a set of violations.
 *
 * @remarks
 * `warn` is the default rather than `throw`, deliberately. A validation bug
 * that takes down a user's editor mid-sentence is worse than the invalid
 * state it was guarding against — the document is still in memory and still
 * savable. Applications that would rather fail a test suite loudly set
 * `throw`.
 *
 * @category Blocks
 */
export function report(violations: Violation[], mode: ValidationMode): void {
  if (mode === 'off' || violations.length === 0) return;
  if (mode === 'throw') throw new ValidationError(violations);
  for (const v of violations) console.warn(`[nbe] ${v.type}#${v.blockId}: ${v.message}`);
}
