/**
 * The mermaid feature: what draws the diagram, and the only half that needs a
 * DOM. The package's main entry stays free of it, so `@nbe/markdown` and the
 * static renderer could consume the mode helpers without pulling in the view —
 * the layering §9 requires and CI enforces.
 *
 * @module @nbe/blocks-mermaid/dom
 */
import { getBlock, plainText, type BlockId } from '@nbe/core';
import type { EditorFeature, EditorView } from '@nbe/dom';
import { MERMAID_MODES, mermaidMode } from './index';

type Renderer = { render(id: string, text: string): Promise<{ svg: string }> };

let renderer: Promise<Renderer | null> | null = null;

/**
 * Mermaid, or `null` where it is not installed.
 *
 * @remarks
 * One import for the whole document, cached including its failure: a vault
 * without the dependency must not re-attempt the import for every diagram on
 * every keystroke.
 */
async function load(): Promise<Renderer | null> {
  renderer ??= import('mermaid')
    .then((module) => {
      const api = (module as { default?: unknown }).default as
        | (Renderer & { initialize(config: Record<string, unknown>): void })
        | undefined;
      if (!api) return null;
      // `startOnLoad` false, or mermaid scans the page and rewrites elements
      // it does not own — which here would be the editable text itself
      api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      return api;
    })
    .catch(() => null);
  return renderer;
}

const PANEL = 'nbe-mermaid';
let seq = 0;

/** Every code block whose language is `mermaid`. */
function diagrams(view: EditorView): BlockId[] {
  const out: BlockId[] = [];
  for (const block of view.editor.doc.blocks.values()) {
    if (block.type === 'code' && String(block.props['language'] ?? '') === 'mermaid') out.push(block.id);
  }
  return out;
}

export const mermaidFeature: EditorFeature = {
  name: 'mermaid',
  attach(view) {
    /** The source last drawn for a block, so an unrelated edit redraws nothing. */
    const drawn = new Map<BlockId, string>();

    const apply = (id: BlockId): void => {
      const el = view.blockEl(id);
      const block = view.editor.doc.blocks.get(id);
      if (!el || !block || block.type !== 'code') return;
      if (String(block.props['language'] ?? '') !== 'mermaid') {
        el.querySelector(`:scope > .${PANEL}`)?.remove();
        el.removeAttribute('data-mermaid-mode');
        drawn.delete(id);
        return;
      }

      const mode = mermaidMode(block.props);
      el.dataset['mermaidMode'] = mode;

      let panel = el.querySelector<HTMLElement>(`:scope > .${PANEL}`);
      if (!panel) {
        /*
         * No panel means the block was re-rendered and took the old one with
         * it — changing the mode does exactly that. The cache is keyed by the
         * source, so without this the redraw is skipped as "already drawn" and
         * the new panel stays empty: switching to Aperçu showed nothing at all.
         */
        drawn.delete(id);
        panel = document.createElement('div');
        panel.className = PANEL;
        panel.setAttribute('contenteditable', 'false');

        const modes = document.createElement('div');
        modes.className = 'nbe-mermaid-modes';
        for (const option of MERMAID_MODES) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'nbe-mermaid-mode';
          button.textContent = option.label;
          button.dataset['mode'] = option.id;
          // pressing chrome must not take the caret out of the block
          button.addEventListener('mousedown', (e) => e.preventDefault());
          button.addEventListener('click', () => {
            view.editor.dispatch(
              (tx) => tx.op({ type: 'update_block', id, patch: { props: { mermaidMode: option.id } } }),
              { origin: 'ui' },
            );
          });
          modes.append(button);
        }
        const figure = document.createElement('div');
        figure.className = 'nbe-mermaid-figure';
        panel.append(modes, figure);
        el.append(panel);
      }

      for (const button of panel.querySelectorAll<HTMLElement>('.nbe-mermaid-mode')) {
        button.classList.toggle('nbe-active', button.dataset['mode'] === mode);
        button.setAttribute('aria-pressed', String(button.dataset['mode'] === mode));
      }

      const source = plainText(getBlock(view.editor.doc, id).text).trim();
      if (drawn.get(id) === source) return;
      drawn.set(id, source);
      const figure = panel.querySelector<HTMLElement>('.nbe-mermaid-figure')!;
      if (!source) {
        figure.replaceChildren();
        return;
      }
      void load().then(async (api) => {
        if (!api || drawn.get(id) !== source) return;
        try {
          const { svg } = await api.render(`nbe-mermaid-${++seq}`, source);
          if (drawn.get(id) !== source) return; // typed on while we were drawing
          figure.innerHTML = svg;
          figure.dataset['error'] = '';
        } catch {
          // an unfinished diagram is the normal state while it is being typed:
          // keep the last good drawing rather than flashing an error at every
          // keystroke, and say so only when there is nothing to keep
          if (!figure.firstChild) figure.dataset['error'] = 'on';
        }
      });
    };

    const applyAll = () => {
      for (const id of diagrams(view)) apply(id);
    };

    applyAll();
    const unsubscribe = view.editor.on((change) => {
      // after the view has repainted the blocks it dirtied, or the panel is
      // appended to an element about to be thrown away
      queueMicrotask(() => {
        const dirty = [...change.dirty];
        if (dirty.length) for (const id of dirty) apply(id);
        else applyAll();
      });
    });

    return () => {
      unsubscribe();
      for (const el of view.content.querySelectorAll(`.${PANEL}`)) el.remove();
    };
  },
};

export { MERMAID_MODES, mermaidMode, mermaidStyles } from './index';
export type { MermaidMode } from './index';
