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

/** The stylesheet the feature needs; inject it beside the editor's own. */
export const mermaidStyles = `
/*
 * Aperçu hides the source — until you put the caret in the block, and then it
 * is back for as long as you are there. Without that, the only way to edit a
 * diagram was to switch to Code, and nothing switched back: the mode is a
 * prop, so it stayed in Code for good. the :focus-within selector is the whole of it, so
 * blurring restores the drawing with no listener and no state to get wrong.
 */
.nbe-t-code[data-mermaid-mode='preview'] > .nbe-row {
  display: none;
}
.nbe-t-code[data-mermaid-mode='preview']:focus-within > .nbe-row,
.nbe-t-code[data-mermaid-mode='preview'].nbe-mermaid-editing > .nbe-row {
  display: flex;
}
.nbe-t-code[data-mermaid-mode='preview']:focus-within > .nbe-mermaid,
.nbe-t-code[data-mermaid-mode='preview'].nbe-mermaid-editing > .nbe-mermaid {
  margin-top: 10px;
  border-top: 1px solid var(--nbe-border);
  padding-top: 8px;
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
