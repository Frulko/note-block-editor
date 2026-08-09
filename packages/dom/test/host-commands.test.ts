// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, type BlockJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { exportFeature, findFeature } from '../src/features';
import { openFind } from '../src/search';
import { openExport } from '../src/export';

/**
 * `⌘F` and `⌘P` reachable from a host's own command system.
 *
 * @remarks
 * Both features take their key in the capture phase, which is what a plugin
 * must do inside an application that already owns the shortcut — and it is a
 * race the application should win, because its hotkey table is where a user
 * goes to rebind. So a host registers a command and calls in here instead. The
 * contract worth pinning is that an unattached feature *says so* rather than
 * throwing or silently doing nothing, and that a destroyed view stops
 * answering: a stale opener would raise a bar over a document that is gone.
 */

const DOC: BlockJSON = {
  id: 'root',
  type: 'page',
  version: 1,
  children: [{ id: 'a', type: 'paragraph', version: 1, text: [{ text: 'bonjour' }] }],
};

function mount(features: typeof findFeature[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const view = new EditorView(container, new Editor({ doc: docFromJSON(DOC) }), { features });
  return { view, cleanup: () => (view.destroy(), container.remove()) };
}

describe('a host can open the find bar and the export menu', () => {
  it('answers false when the feature was left out', () => {
    const { view, cleanup } = mount([]);
    expect(openFind(view)).toBe(false);
    expect(openExport(view)).toBe(false);
    cleanup();
  });

  it('opens the export menu when the feature is attached', () => {
    const { view, cleanup } = mount([exportFeature]);
    expect(openExport(view)).toBe(true);
    expect(document.querySelector('.nbe-export-menu')).not.toBeNull();
    cleanup();
  });

  it('stops answering once the view is destroyed', () => {
    const { view, cleanup } = mount([exportFeature]);
    cleanup();
    expect(openExport(view)).toBe(false);
  });
});
