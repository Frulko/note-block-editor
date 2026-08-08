import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor';
import { docFromJSON, docToJSON, getBlock } from '../src/doc';
import { toggleMarkRange } from '../src/commands';
import type { BlockJSON } from '../src/doc';
import type { TextSelection } from '../src/types';

/**
 * The architecture's own claims, run against the code.
 *
 * @remarks
 * `docs/ARCHITECTURE.md` states these as decisions, and a decision that is only
 * stated drifts. The topology claim in the roadmap was stated for weeks and was
 * false when finally run; these are the same kind of statement and deserve the
 * same treatment.
 */

const range = (id: string, from: number, to: number): TextSelection => ({
  kind: 'text',
  anchor: { blockId: id, offset: from },
  head: { blockId: id, offset: to },
});

/** Every key present anywhere in a JSON tree. */
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysIn(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysIn(item, out);
    }
  }
  return out;
}

describe('D4: inline text is runs, never offset spans', () => {
  it('a marked document persists no offsets at all', () => {
    /*
     * The rule that makes a CRDT possible (§2.2): offsets live in op payloads
     * and ephemeral selection, never in anything persisted. Two clients that
     * both stored "bold from 3 to 7" would disagree the moment either typed
     * above it — which is why D4 chose runs.
     */
    const editor = new Editor();
    const block = {
      id: 'a',
      type: 'paragraph' as const,
      version: 1,
      props: {},
      text: [{ text: 'un texte à marquer' }],
      children: [],
      parentId: editor.doc.rootId,
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }), { addToHistory: false });
    editor.setSelection(range('a', 3, 9));
    toggleMarkRange(editor, 'bold');
    editor.setSelection(range('a', 6, 12));
    toggleMarkRange(editor, 'italic');

    const json = docToJSON(editor.doc);
    const keys = keysIn(json);
    for (const forbidden of ['from', 'to', 'start', 'end', 'offset', 'index', 'length', 'pos']) {
      expect([...keys], `a persisted "${forbidden}" would be an offset span`).not.toContain(forbidden);
    }
    // and the marks really are there — the assertion above must not pass vacuously
    expect(JSON.stringify(json)).toContain('bold');
    expect(JSON.stringify(json)).toContain('italic');
  });

  it('overlapping marks stay expressible as runs', () => {
    const editor = new Editor();
    const block = {
      id: 'a',
      type: 'paragraph' as const,
      version: 1,
      props: {},
      text: [{ text: 'abcdefgh' }],
      children: [],
      parentId: editor.doc.rootId,
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }), { addToHistory: false });
    editor.setSelection(range('a', 0, 5));
    toggleMarkRange(editor, 'bold');
    editor.setSelection(range('a', 3, 8));
    toggleMarkRange(editor, 'italic');

    const runs = getBlock(editor.doc, 'a').text!;
    // bold-only, both, italic-only — the overlap becomes a run, not a span
    expect(runs.map((run) => run.text).join('')).toBe('abcdefgh');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const both = runs.find((run) => (run.marks ?? []).length === 2);
    expect(both?.text).toBe('de');
  });
});

describe('§4: what this version does not understand, it does not destroy', () => {
  it('an unknown block type survives a full JSON round trip with its props', () => {
    /*
     * The forward-compatibility promise: a document written by a newer build,
     * opened here and saved, must not lose what this build cannot render. The
     * Swift port asserts the same thing (`PortabilityTests`); this is the
     * TypeScript half, and having both is what makes it a format rather than
     * an implementation detail.
     */
    const original: BlockJSON = {
      id: 'root',
      type: 'page',
      version: 1,
      children: [
        {
          id: 'x',
          type: 'diagramme-du-futur',
          version: 7,
          props: { nodes: [{ id: 'n1', label: 'é' }], zoom: 1.5, épinglé: true },
          children: [{ id: 'y', type: 'paragraph', version: 1, text: [{ text: 'dedans' }] }],
        },
      ],
    };

    const round = docToJSON(docFromJSON(original)) as BlockJSON;
    const kept = round.children![0]!;
    expect(kept.type).toBe('diagramme-du-futur');
    expect(kept.version).toBe(7);
    expect(kept.props).toEqual(original.children![0]!.props);
    expect(kept.children![0]!.type).toBe('paragraph');
  });

  it('an integer prop does not become a float on the way through', () => {
    // the trap the Swift port hit: `1` re-encoding as `1.0` breaks equality
    // between the two implementations for a document neither one changed
    const original: BlockJSON = {
      id: 'root',
      type: 'page',
      version: 1,
      children: [{ id: 'x', type: 'compteur', version: 1, props: { n: 1, ratio: 1.5 } }],
    };
    const round = docToJSON(docFromJSON(original)) as BlockJSON;
    expect(JSON.stringify(round.children![0]!.props)).toBe(JSON.stringify({ n: 1, ratio: 1.5 }));
  });
});
