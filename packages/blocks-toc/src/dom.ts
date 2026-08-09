/**
 * The table of contents' editing behaviour: its rendering, its slash entry,
 * and the one thing no other block needs — staying current when a *different*
 * block changes.
 *
 * @module @nbe/blocks-toc/dom
 */
import { visibleBlocks, plainText, type Block } from '@nbe/core';
import { renderBlock, reveal, type DomBlockPlugin, type EditorFeature } from '@nbe/dom';
import { tocPlugin, type TocEntry } from './index';

/** The page's headings, read from the live document rather than a snapshot. */
function headings(view: { editor: { doc: Parameters<typeof visibleBlocks>[0] } }): TocEntry[] {
  const out: TocEntry[] = [];
  for (const block of visibleBlocks(view.editor.doc) as Block[]) {
    if (block.type !== 'heading') continue;
    const text = plainText(block.text).trim();
    if (!text) continue;
    const level = Number(block.props['level'] ?? 1);
    out.push({ id: block.id, level: Math.min(3, Math.max(1, level || 1)), text });
  }
  return out;
}

function fill(view: import('@nbe/dom').EditorView, list: HTMLElement): void {
  const entries = headings(view);
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'nbe-toc-empty';
    empty.textContent =
      view.labels.placeholders['table_of_contents'] ??
      view.editor.schema.get('table_of_contents').placeholder ??
      '';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li');
      item.className = `nbe-toc-l${entry.level}`;
      const link = document.createElement('a');
      // a real href, so the entry is a link to middle-click, copy and export —
      // and the anchor is the block id, which is what the HTML export emits
      link.href = `#${entry.id}`;
      link.textContent = entry.text;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = view.blockEl(entry.id);
        if (!target) return;
        reveal(target);
        view.focusBlock(entry.id, 0);
      });
      item.append(link);
      return item;
    }),
  );
}

/**
 * Re-render every contents block when a heading changes.
 *
 * @remarks
 * The view repaints the blocks a transaction dirtied, which is exactly right
 * for every block that owns its content and exactly wrong for this one: typing
 * in a heading dirties the *heading*. Hence a feature rather than a hook —
 * it is editor-wide behaviour, not per-block rendering.
 *
 * Gated on a heading actually being involved, because the alternative is
 * walking the document on every keystroke, and `e2e/performance.spec.ts`
 * measures that at 500 blocks.
 */
const refreshFeature: EditorFeature = {
  name: 'toc-refresh',
  attach(view) {
    return view.editor.on((change) => {
      const doc = view.editor.doc;
      const relevant = [...change.dirty].some((id) => {
        const block = doc.blocks.get(id);
        return !block || block.type === 'heading' || block.id === doc.rootId;
      });
      if (!relevant) return;
      for (const el of view.content.querySelectorAll<HTMLElement>('.nbe-t-table_of_contents')) {
        const list = el.querySelector<HTMLElement>('.nbe-toc-list');
        if (list) fill(view, list);
      }
    });
  },
};

/**
 * The table of contents, ready to mount.
 *
 * @example
 * ```ts
 * import { toc } from '@nbe/blocks-toc/dom'
 * new EditorView(el, editor, { blocks: [toc] })
 * ```
 *
 * @category Plugins
 */
export const toc: DomBlockPlugin = {
  ...tocPlugin,
  view: {
    render(ctx, block) {
      const nav = document.createElement('nav');
      nav.setAttribute('aria-label', 'Table des matières');
      const list = document.createElement('ul');
      list.className = 'nbe-toc-list';
      fill(ctx.view, list);
      nav.append(list);
      // void: no caret goes in here, and a press on it is a grab, not an edit
      ctx.root.setAttribute('contenteditable', 'false');
      ctx.root.dataset['blockId'] = block.id;
      ctx.root.append(nav);
      return ctx.root;
    },

    slash: {
      label: 'Sommaire',
      keywords: ['sommaire', 'toc', 'table des matières', 'matières', 'contents', 'plan'],
      icon: 'list',
    },

    features: [refreshFeature],

    styles: `
.nbe-t-table_of_contents {
  padding: 4px 2px;
}
.nbe-toc-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 2px solid var(--nbe-border);
}
.nbe-toc-list li {
  margin: 0;
}
.nbe-toc-list a {
  display: block;
  padding: 2px 10px;
  color: var(--nbe-text-muted);
  text-decoration: none;
  border-radius: var(--nbe-radius-sm, 4px);
  transition: background var(--nbe-fast) var(--nbe-ease), color var(--nbe-fast) var(--nbe-ease);
}
.nbe-toc-list a:hover {
  background: var(--nbe-hover);
  color: var(--nbe-text);
}
.nbe-toc-l2 a { padding-left: 26px; }
.nbe-toc-l3 a { padding-left: 42px; }
.nbe-toc-empty {
  padding: 2px 10px;
  color: var(--nbe-placeholder);
}
`,
  },
};

export { tocPlugin, tocMarkdown, tocEntries, TOC_MARKER } from './index';
export type { TocEntry } from './index';
