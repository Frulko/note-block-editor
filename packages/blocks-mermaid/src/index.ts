/**
 * Mermaid diagrams, drawn from the code block that already holds them.
 *
 * @remarks
 * **No new block type, and no change to the file format.** ` ```mermaid ` is
 * how every Markdown tool on earth writes a diagram, and this editor already
 * parses that into a code block whose `language` is `mermaid` — which already
 * round-trips byte for byte. A new `mermaid` block would have had to fight the
 * code block for the same fence, for nothing.
 *
 * So this is a *feature*, not a plugin: it watches for code blocks in that
 * language and draws the diagram beside the source. The rendered SVG lives
 * outside the editable leaf, exactly as the syntax colours live outside it —
 * the caret, the IME and the DOM→model reconciler never learn a diagram is on
 * screen.
 *
 * **Mermaid itself is an optional peer dependency, imported on first use.** A
 * page with no diagram pays nothing; a host that never installs it gets a
 * plain code block and no error. That is the same bargain the syntax grammars
 * make, and the reason a 2 MB library can be offered at all in a project that
 * refuses network dependencies at runtime.
 *
 * @module @nbe/blocks-mermaid
 */

/** How a diagram block is shown. Stored on the code block's own props. */
export type MermaidMode = 'preview' | 'code' | 'both';

export const MERMAID_MODES: ReadonlyArray<{ id: MermaidMode; label: string }> = [
  { id: 'preview', label: 'Aperçu' },
  { id: 'code', label: 'Code' },
  { id: 'both', label: 'Les deux' },
];

/** The mode a block is in, defaulting to showing both. */
export function mermaidMode(props: Record<string, unknown>): MermaidMode {
  const value = props['mermaidMode'];
  return value === 'preview' || value === 'code' ? value : 'both';
}

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

/** The stylesheet the feature needs; inject it beside the editor's own. */
export const mermaidStyles = `
.nbe-t-code[data-mermaid-mode='preview'] > .nbe-row {
  display: none;
}
.nbe-t-code[data-mermaid-mode='code'] .nbe-mermaid-figure {
  display: none;
}
.nbe-mermaid {
  position: relative;
  margin-top: 10px;
  border-top: 1px solid var(--nbe-border);
  padding-top: 8px;
}
.nbe-t-code[data-mermaid-mode='preview'] > .nbe-mermaid {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}
.nbe-mermaid-modes {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
}
.nbe-mermaid-mode {
  font: inherit;
  font-size: 11px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--nbe-text-light);
  padding: 2px 8px;
  cursor: pointer;
  transition: background var(--nbe-fast) var(--nbe-ease), color var(--nbe-fast) var(--nbe-ease);
}
.nbe-mermaid-mode:hover {
  background: var(--nbe-hover);
}
.nbe-mermaid-mode.nbe-active {
  background: var(--nbe-hover-strong);
  color: var(--nbe-text);
}
.nbe-mermaid-figure {
  display: flex;
  justify-content: center;
  overflow-x: auto;
}
.nbe-mermaid-figure svg {
  max-width: 100%;
  height: auto;
}
.nbe-mermaid-figure[data-error='on']::before {
  content: attr(data-message);
  color: var(--nbe-text-faint);
  font-size: 12px;
}
`;
