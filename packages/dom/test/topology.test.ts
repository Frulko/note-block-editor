// @vitest-environment happy-dom
//
// The cornerstone claim: every interaction primitive is written against the
// topology, so the same document behaves identically whether there is one
// contenteditable per block or a single editable root. These tests are the
// claim, not a description of it — each one runs against both.
import { describe, expect, it } from 'vitest';
import { Editor, createDoc, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { perBlockTopology, singleHostTopology, leafOf, nativeRangeSpans } from '../src/topology';
import { domToModelPoint, modelPointToDom } from '../src/selection';

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [
    { id: 'a', type: 'paragraph', version: 1, text: [{ text: 'premier bloc' }] },
    { id: 'b', type: 'paragraph', version: 1, text: [{ text: 'second bloc' }] },
  ],
};

const TOPOLOGIES = [
  { name: 'per-block', topology: perBlockTopology },
  { name: 'single-host', topology: singleHostTopology },
] as const;

function mount(topology = perBlockTopology) {
  const container = document.createElement('div');
  document.body.append(container);
  const editor = new Editor({ doc: docFromJSON(DOC) });
  const view = new EditorView(container, editor, { topology });
  return {
    view,
    editor,
    leaf: (id: string) => view.leafEl(id)!,
    destroy: () => {
      view.destroy();
      container.remove();
    },
  };
}

describe.each(TOPOLOGIES)('selection primitives under $name', ({ topology }) => {
  it('maps a DOM position to the right block and offset', () => {
    const t = mount(topology);
    const textNode = t.leaf('b').firstChild!;
    expect(domToModelPoint(textNode, 6)).toEqual({ blockId: 'b', offset: 6 });
    t.destroy();
  });

  it('round-trips a model point through the DOM', () => {
    const t = mount(topology);
    const dom = modelPointToDom(t.view, { blockId: 'a', offset: 7 })!;
    expect(domToModelPoint(dom.node, dom.offset)).toEqual({ blockId: 'a', offset: 7 });
    t.destroy();
  });

  it('finds the leaf for a node regardless of where contenteditable sits', () => {
    const t = mount(topology);
    expect(leafOf(t.leaf('a').firstChild)).toBe(t.leaf('a'));
    expect(leafOf(document.body)).toBeNull();
    t.destroy();
  });

  it('renders one leaf per block either way', () => {
    const t = mount(topology);
    expect(t.view.content.querySelectorAll('.nbe-leaf')).toHaveLength(2);
    t.destroy();
  });
});

describe('per-block topology', () => {
  it('makes every leaf its own editable host', () => {
    const t = mount(perBlockTopology);
    expect(t.leaf('a').getAttribute('contenteditable')).toBeTruthy();
    expect(t.view.content.getAttribute('contenteditable')).toBeNull();
    t.destroy();
  });

  it('keeps the single tab stop on the root, not on the leaves', () => {
    const t = mount(perBlockTopology);
    expect(t.leaf('a').tabIndex).toBe(-1);
    expect(t.view.content.tabIndex).toBe(0);
    t.destroy();
  });

  it('reports that the browser cannot natively span two blocks', () => {
    // this false is exactly why the cross-block driver exists
    const t = mount(perBlockTopology);
    expect(nativeRangeSpans(perBlockTopology, t.leaf('a').firstChild, t.leaf('b').firstChild)).toBe(false);
    expect(nativeRangeSpans(perBlockTopology, t.leaf('a').firstChild, t.leaf('a'))).toBe(true);
    t.destroy();
  });
});

describe('single-host topology', () => {
  it('puts the editable host on the root and leaves the leaves plain', () => {
    const t = mount(singleHostTopology);
    expect(t.view.content.getAttribute('contenteditable')).toBeTruthy();
    expect(t.leaf('a').getAttribute('contenteditable')).toBeNull();
    t.destroy();
  });

  it('reports that the browser spans blocks natively, which disables the driver', () => {
    const t = mount(singleHostTopology);
    expect(nativeRangeSpans(singleHostTopology, t.leaf('a').firstChild, t.leaf('b').firstChild)).toBe(true);
    t.destroy();
  });

  it('still reports nothing for a node outside the editor', () => {
    const t = mount(singleHostTopology);
    expect(nativeRangeSpans(singleHostTopology, document.body, t.leaf('a'))).toBe(false);
    t.destroy();
  });
});

describe('the view records which topology it runs', () => {
  it('defaults to per-block, the shipped decision D1', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const view = new EditorView(container, new Editor({ doc: createDoc() }));
    expect(view.topology.name).toBe('per-block');
    expect(view.content.dataset['topology']).toBe('per-block');
    view.destroy();
    container.remove();
  });

  it('exposes the choice so CSS and tooling can see it', () => {
    const t = mount(singleHostTopology);
    expect(t.view.content.dataset['topology']).toBe('single-host');
    t.destroy();
  });
});
