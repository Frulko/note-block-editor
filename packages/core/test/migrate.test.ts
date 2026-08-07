// Phase 1 listed "schema registry with versioned migrations" and "per-block
// validation at apply". The version field existed and nothing read it; apply
// checked structure and never the schema. These close both.
import { describe, expect, it, vi } from 'vitest';
import { Schema } from '../src/schema';
import { migrateBlock, migrateJSON, emptyReport, needsAttention } from '../src/migrate';
import { validateBlock, validateDoc, report, ValidationError } from '../src/validate';
import { docFromJSON, createDoc } from '../src/doc';
import { Editor } from '../src/editor';
import type { Block } from '../src/types';

const block = (over: Partial<Block> = {}): Block => ({
  id: 'b1',
  type: 'note',
  version: 1,
  props: {},
  children: [],
  parentId: 'root',
  ...over,
});

describe('migrations run one step at a time', () => {
  it('leaves a current block untouched', () => {
    const schema = new Schema().register({ type: 'note', version: 1, inline: true });
    const r = emptyReport();
    const b = block();
    expect(migrateBlock(schema, b, r)).toBe(b);
    expect(r.migrated).toEqual([]);
  });

  it('runs every step between the block and the schema, in order', () => {
    const seen: number[] = [];
    const schema = new Schema().register({
      type: 'note',
      version: 4,
      inline: true,
      migrations: {
        1: (b) => (seen.push(1), { ...b, props: { ...b.props, a: true } }),
        2: (b) => (seen.push(2), { ...b, props: { ...b.props, b: true } }),
        3: (b) => (seen.push(3), { ...b, props: { ...b.props, c: true } }),
      },
    });
    const r = emptyReport();
    const out = migrateBlock(schema, block(), r);
    expect(seen).toEqual([1, 2, 3]);
    expect(out.props).toEqual({ a: true, b: true, c: true });
    expect(out.version).toBe(4);
    expect(r.migrated).toEqual([{ id: 'b1', type: 'note', from: 1, to: 4 }]);
  });

  it('treats a missing step as a shape-preserving bump', () => {
    // a version bump with no shape change is the common case; demanding an
    // identity function for it would be noise
    const schema = new Schema().register({ type: 'note', version: 3, inline: true });
    const out = migrateBlock(schema, block(), emptyReport());
    expect(out.version).toBe(3);
    expect(out.props).toEqual({});
  });

  it('never mutates the block it was given', () => {
    const schema = new Schema().register({
      type: 'note',
      version: 2,
      inline: true,
      migrations: { 1: (b) => ({ ...b, props: { migrated: true } }) },
    });
    const original = block();
    migrateBlock(schema, original, emptyReport());
    expect(original.version).toBe(1);
    expect(original.props).toEqual({});
  });
});

describe('what migrations refuse to touch', () => {
  it('preserves a block whose type is not registered, and reports it', () => {
    // an unloaded plugin's block must not cost the user their content
    const schema = new Schema();
    const r = emptyReport();
    const b = block({ type: 'from-a-plugin' });
    expect(migrateBlock(schema, b, r)).toBe(b);
    expect(r.unknown).toEqual([{ id: 'b1', type: 'from-a-plugin' }]);
    expect(needsAttention(r)).toBe(true);
  });

  it('preserves a block from a newer build, and flags it as alarming', () => {
    const schema = new Schema().register({ type: 'note', version: 2, inline: true });
    const r = emptyReport();
    const b = block({ version: 5 });
    expect(migrateBlock(schema, b, r)).toBe(b);
    expect(r.fromFuture).toEqual([{ id: 'b1', type: 'note', version: 5, supported: 2 }]);
  });

  it('says nothing needs attention when everything is known and current', () => {
    const schema = new Schema().register({ type: 'note', version: 1, inline: true });
    const r = emptyReport();
    migrateBlock(schema, block(), r);
    expect(needsAttention(r)).toBe(false);
  });
});

describe('migrating a whole document', () => {
  const schema = new Schema()
    .register({ type: 'page', version: 1, inline: false, layout: true })
    .register({
      type: 'note',
      version: 2,
      inline: true,
      migrations: { 1: (b) => ({ ...b, props: { ...b.props, variant: 'note' } }) },
    });

  const json = {
    id: 'root',
    type: 'page',
    version: 1,
    children: [
      { id: 'a', type: 'note', version: 1, text: [{ text: 'un' }] },
      { id: 'b', type: 'note', version: 2, text: [{ text: 'deux' }] },
      { id: 'c', type: 'mystery', version: 1 },
    ],
  };

  it('upgrades only what is behind', () => {
    const { json: out, report: r } = migrateJSON(json, schema);
    expect(r.migrated.map((m) => m.id)).toEqual(['a']);
    expect(out.children![0]!.props).toEqual({ variant: 'note' });
    expect(out.children![1]!.props).toBeUndefined();
  });

  it('keeps the unknown block exactly as it was', () => {
    const { json: out, report: r } = migrateJSON(json, schema);
    expect(r.unknown).toEqual([{ id: 'c', type: 'mystery' }]);
    expect(out.children![2]).toEqual({ id: 'c', type: 'mystery', version: 1 });
  });

  it('runs at the load boundary when docFromJSON is given a schema', () => {
    const seen: Array<{ id: string }> = [];
    const doc = docFromJSON(json, { schema, onReport: (r) => seen.push(...r.migrated) });
    expect(seen.map((m) => m.id)).toEqual(['a']);
    expect(doc.blocks.get('a')!.version).toBe(2);
  });

  it('does nothing without a schema, so existing callers are unaffected', () => {
    const doc = docFromJSON(json);
    expect(doc.blocks.get('a')!.version).toBe(1);
  });
});

describe('per-block validation', () => {
  const schema = new Schema()
    .register({ type: 'para', version: 1, inline: true })
    .register({ type: 'rule', version: 1, inline: false })
    .register({ type: 'cols', version: 1, inline: false, layout: true });

  it('accepts a well-formed block', () => {
    expect(validateBlock(schema, block({ type: 'para' }))).toEqual([]);
  });

  it('rejects text on a block that carries none', () => {
    // invisible in the editor and dropped by every projection: exactly the
    // silent loss this project exists to prevent
    const v = validateBlock(schema, block({ type: 'rule', text: [{ text: 'perdu' }] }));
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('no inline text');
  });

  it('rejects a version newer than the schema knows', () => {
    expect(validateBlock(schema, block({ type: 'para', version: 9 }))[0]!.message).toContain('newer');
  });

  it('rejects an empty layout container', () => {
    expect(validateBlock(schema, block({ type: 'cols' }))[0]!.message).toContain('no children');
  });

  it('says nothing about a type it does not know', () => {
    // preserved by design; the load path reports it separately
    expect(validateBlock(schema, block({ type: 'plugin-block', text: [{ text: 'x' }] }))).toEqual([]);
  });

  it('runs a block type’s own extra checks', () => {
    const withProps = new Schema().register({
      type: 'head',
      version: 1,
      inline: true,
      validate: (b) => (typeof b.props['level'] === 'number' ? [] : ['level must be a number']),
    });
    expect(validateBlock(withProps, block({ type: 'head' }))[0]!.message).toBe('level must be a number');
    expect(validateBlock(withProps, block({ type: 'head', props: { level: 1 } }))).toEqual([]);
  });

  it('catches a dangling child reference when given the document', () => {
    // the schema must know the root's type, or validation correctly bails out
    // early: an unknown type is preserved, not policed
    const withPage = new Schema().register({ type: 'page', version: 1, inline: false, layout: true });
    const doc = createDoc();
    doc.blocks.get(doc.rootId)!.children.push('ghost');
    expect(validateDoc(withPage, doc).some((v) => v.message.includes('ghost'))).toBe(true);
  });
});

describe('how violations surface', () => {
  it('warns by default rather than taking the editor down mid-sentence', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    report([{ blockId: 'b', type: 't', message: 'boom' }], 'warn');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('throws when a caller asks for it, naming every violation', () => {
    expect(() => report([{ blockId: 'b', type: 't', message: 'boom' }], 'throw')).toThrow(ValidationError);
    expect(() => report([{ blockId: 'b', type: 't', message: 'boom' }], 'throw')).toThrow(/t#b: boom/);
  });

  it('stays silent when switched off', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    report([{ blockId: 'b', type: 't', message: 'boom' }], 'off');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('validates the blocks a transaction touched, not the whole document', () => {
    const editor = new Editor({ validation: 'throw' });
    const bad: Block = {
      id: 'x',
      type: 'divider',
      version: 1,
      props: {},
      text: [{ text: 'invisible' }],
      children: [],
      parentId: editor.doc.rootId,
    };
    expect(() => editor.dispatch((tx) => tx.op({ type: 'insert_block', block: bad, index: 0 }))).toThrow(
      ValidationError,
    );
  });
});
