import type { Block } from './types';
// type-only, so the doc.ts <-> migrate.ts cycle is erased at runtime
import type { BlockJSON } from './doc';
import type { Schema } from './schema';

/**
 * Schema migrations.
 *
 * @remarks
 * Every `BlockSpec` has carried a `version` since the beginning; nothing read
 * it. That is the expensive kind of gap — free today, and very costly the
 * first time a shipped block changes shape, because by then documents in the
 * wild already hold the old form.
 *
 * Two rules make this survivable, and both come from §10's "additive-only
 * evolution, unknown types and fields preserved":
 *
 * 1. **One step per version.** A migration upgrades from `n` to `n + 1` and
 *    nothing else. Upgrading a v1 block to v4 runs three small functions
 *    rather than one function that has to know every path. Steps compose;
 *    jumps do not.
 * 2. **An unknown type is never touched.** A document may legitimately contain
 *    blocks from a plugin the current build has not loaded. Rewriting or
 *    dropping those would destroy data the user can still see elsewhere, so
 *    they pass through unchanged and are reported.
 *
 * @category Blocks
 */

/** Upgrades a block by exactly one version. */
export type Migration = (block: Block) => Block;

export interface MigrationReport {
  /** Blocks whose version was raised, with the range covered. */
  migrated: Array<{ id: string; type: string; from: number; to: number }>;
  /**
   * Blocks the current schema does not know. Preserved untouched — a plugin
   * that is simply not loaded must not cost the user their content.
   */
  unknown: Array<{ id: string; type: string }>;
  /**
   * Blocks whose version is *newer* than this build's schema. Also preserved,
   * and much more alarming: it means the document was written by a newer
   * version of the app, so anything this build saves may lose what it cannot
   * represent.
   */
  fromFuture: Array<{ id: string; type: string; version: number; supported: number }>;
}

export function emptyReport(): MigrationReport {
  return { migrated: [], unknown: [], fromFuture: [] };
}

/** True when the report contains anything a caller should act on. */
export function needsAttention(report: MigrationReport): boolean {
  return report.unknown.length > 0 || report.fromFuture.length > 0;
}

/**
 * Bring one block up to the schema's current version.
 *
 * @param schema - The registry holding the target versions and migrations.
 * @param block - The block to upgrade. Never mutated.
 * @param report - Accumulates what happened, for the caller to surface.
 * @returns The upgraded block, or the original when nothing applies.
 *
 * @category Blocks
 */
export function migrateBlock(schema: Schema, block: Block, report: MigrationReport): Block {
  if (!schema.has(block.type)) {
    report.unknown.push({ id: block.id, type: block.type });
    return block;
  }
  const spec = schema.get(block.type);
  const from = block.version;

  if (from > spec.version) {
    report.fromFuture.push({ id: block.id, type: block.type, version: from, supported: spec.version });
    return block;
  }
  if (from === spec.version) return block;

  let current = block;
  for (let v = from; v < spec.version; v++) {
    const step = spec.migrations?.[v];
    // a missing step is not an error: a version bump with no shape change is
    // the common case, and demanding an identity function for it is noise
    current = step ? { ...step(current), version: v + 1 } : { ...current, version: v + 1 };
  }
  report.migrated.push({ id: block.id, type: block.type, from, to: spec.version });
  return current;
}

/**
 * Migrate a whole document tree, depth-first.
 *
 * @remarks
 * Runs at the load boundary — {@link docFromJSON} calls it when given a
 * schema — because that is the one moment a document arrives from storage and
 * the only place where "old" is well defined.
 *
 * @example
 * ```ts
 * const { doc, report } = migrateJSON(json, schema)
 * if (report.fromFuture.length) warnUser()
 * ```
 *
 * @category Blocks
 */
export function migrateJSON(json: BlockJSON, schema: Schema): { json: BlockJSON; report: MigrationReport } {
  const report = emptyReport();
  const walk = (node: BlockJSON): BlockJSON => {
    const asBlock: Block = {
      id: node.id,
      type: node.type,
      version: node.version,
      props: node.props ?? {},
      text: node.text,
      children: [],
      parentId: null,
    };
    const upgraded = migrateBlock(schema, asBlock, report);
    const children = (node.children ?? []).map(walk);
    const out: BlockJSON = { id: upgraded.id, type: upgraded.type, version: upgraded.version };
    if (upgraded.props && Object.keys(upgraded.props).length) out.props = upgraded.props;
    if (upgraded.text?.length) out.text = upgraded.text;
    if (children.length) out.children = children;
    return out;
  };
  return { json: walk(json), report };
}
