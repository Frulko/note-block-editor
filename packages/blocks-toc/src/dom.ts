/**
 * The table of contents' editing behaviour: its rendering, its slash entry,
 * and the one thing no other block needs — staying current when a *different*
 * block changes.
 *
 * @module @nbe/blocks-toc/dom
 */
import { visibleBlocks, plainText, type Block } from '@nbe/core';
import {
  findScrollParent,
  injectBlockStyles,
  renderBlock,
  reveal,
  type DomBlockPlugin,
  type EditorFeature,
} from '@nbe/dom';
import { tocPlugin, tocStyle, TOC_STYLES, type TocEntry } from './index';

/**
 * The floating panel's own sheet.
 *
 * @remarks
 * It restates the few list rules it needs rather than leaning on the block's,
 * because {@link floatingTocFeature} is usable in a host that never registers
 * the block — an outline over a note that contains no `[TOC]` is most of the
 * point of it.
 */
const FLOAT_STYLES = `
.nbe-toc-float {
  position: absolute;
  right: 12px;
  bottom: 20px;
  width: 200px;
  max-height: 50vh;
  overflow: auto;
  padding: 6px 2px;
  border-radius: var(--nbe-radius, 6px);
  background: var(--nbe-surface);
  border: 1px solid var(--nbe-border);
  box-shadow: 0 1px 2px rgb(var(--nbe-shadow-rgb) / var(--nbe-a-shadow-ring)),
    0 4px 12px rgb(var(--nbe-shadow-rgb) / var(--nbe-a-shadow-near));
  font-size: 12px;
  line-height: 1.4;
}
.nbe-toc-float ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.nbe-toc-float li { margin: 0; }
.nbe-toc-float a {
  display: block;
  padding: 3px 8px;
  color: var(--nbe-text-light);
  text-decoration: none;
  border-radius: var(--nbe-radius-sm, 4px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nbe-toc-float a:hover { background: var(--nbe-hover); color: var(--nbe-text); }
.nbe-toc-float .nbe-toc-l2 a { padding-left: 20px; }
.nbe-toc-float .nbe-toc-l3 a { padding-left: 32px; }
/* the section being read */
.nbe-toc-float a.nbe-toc-here {
  color: var(--nbe-text);
  background: var(--nbe-hover);
  box-shadow: inset 2px 0 0 var(--nbe-accent);
}
/* over a narrow pane it would sit on the words: an outline in the way is
   worse than no outline, and the block is still there for anyone who wants one */
@media (max-width: 860px) {
  .nbe-toc-float { display: none; }
}
`;

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

function fill(view: import('@nbe/dom').EditorView, list: HTMLElement, placeholder = true): void {
  const entries = headings(view);
  if (!entries.length) {
    if (!placeholder) return list.replaceChildren();
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
        // `start`, not `nearest`: following a contents entry means arriving at
        // the section, and a heading left clinging to the bottom edge with its
        // section off screen is not arriving anywhere
        reveal(target, 'start');
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
 * The same contents, floating beside the note and following the scroll.
 *
 * @remarks
 * A *feature*, not a second block, and that is the whole design: it reads the
 * same `headings(view)` the block does and lives in `view.slot('floating')`,
 * which is a sibling of the content element — so `renderAll` cannot wipe it and
 * it takes no space in the document. A note does not have to contain a `[TOC]`
 * to get one.
 *
 * The entry it marks is the last heading whose top has passed the top of the
 * scrollport, which is the only definition that behaves at the end of a
 * document: an "is it on screen" test leaves nothing highlighted once the last
 * section is shorter than the viewport.
 *
 * Off by default like every other slot feature — a permanent outline over the
 * text is a preference, not a default. Obsidian exposes it as a setting.
 *
 * @example
 * ```ts
 * import { floatingTocFeature } from '@nbe/blocks-toc/dom'
 * new EditorView(el, editor, { features: [...defaultFeatures, floatingTocFeature] })
 * ```
 *
 * @category Plugins
 */
export const floatingTocFeature: EditorFeature = {
  name: 'floating-toc',
  attach(view) {
    // its own sheet rather than the block's, so the feature stands alone in a
    // host that never registers the block. Idempotent, keyed by this name.
    injectBlockStyles('table_of_contents_float', FLOAT_STYLES);
    const nav = document.createElement('nav');
    nav.className = 'nbe-toc-float';
    nav.setAttribute('aria-label', 'Table des matières');
    const list = document.createElement('ul');
    list.className = 'nbe-toc-list';
    nav.append(list);
    view.slot('floating').append(nav);

    /**
     * Mark the section being read.
     *
     * @remarks
     * Against the *scrollport's* top, not the content element's — the content
     * scrolls with the document, so its top runs negative and every heading
     * stays "above the fold" forever. The same measurement `reveal` makes, and
     * for the same reason: the host owns the scroller.
     */
    const mark = () => {
      const links = [...list.querySelectorAll<HTMLAnchorElement>('a')];
      if (!links.length) return;
      const scroller = findScrollParent(view.content);
      const paging = scroller === document.scrollingElement || scroller === document.documentElement;
      const top = paging ? 0 : scroller.getBoundingClientRect().top;
      // the last heading whose top has passed the fold; the first one until one
      // has, which is what keeps something marked at either end of the document
      let current = links[0]!;
      for (const link of links) {
        const el = view.blockEl(decodeURIComponent(link.hash.slice(1)));
        if (el && el.getBoundingClientRect().top - top <= 8) current = link;
      }
      for (const link of links) link.classList.toggle('nbe-toc-here', link === current);
    };

    const render = () => {
      fill(view, list, false);
      // an outline of nothing is clutter; a note with no headings gets no panel
      nav.hidden = !list.childElementCount;
      mark();
    };

    render();
    /*
     * Gated on a heading, exactly as `refreshFeature` is: the alternative is
     * walking the document on every keystroke, which `e2e/performance.spec.ts`
     * measures at 500 blocks.
     */
    const offChange = view.editor.on((change) => {
      const doc = view.editor.doc;
      if (
        [...change.dirty].some((id) => {
          const block = doc.blocks.get(id);
          return !block || block.type === 'heading' || block.id === doc.rootId;
        })
      )
        queueMicrotask(render);
    });
    // capture, because the scroller is the host's and may be any ancestor
    document.addEventListener('scroll', mark, { capture: true, passive: true });
    return () => {
      offChange();
      document.removeEventListener('scroll', mark, { capture: true });
      nav.remove();
    };
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
      ctx.root.dataset['tocStyle'] = tocStyle(block.props);
      ctx.root.append(nav);
      return ctx.root;
    },

    actions(ctx) {
      const current = tocStyle(ctx.block.props);
      return [
        { kind: 'section', label: 'Affichage' },
        ...TOC_STYLES.map((preset) => ({
          label: preset.label,
          icon: preset.icon,
          hint: current === preset.name ? '✓' : undefined,
          onSelect: () => ctx.setProps({ style: preset.name }),
        })),
      ];
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
}
.nbe-toc-list li {
  margin: 0;
}
.nbe-toc-list a {
  display: block;
  padding: 4px 10px;
  color: var(--nbe-text-muted);
  text-decoration: none;
  border-radius: var(--nbe-radius-sm, 4px);
  transition: background var(--nbe-fast) var(--nbe-ease), color var(--nbe-fast) var(--nbe-ease);
}
.nbe-toc-list a:hover {
  background: var(--nbe-hover);
  color: var(--nbe-text);
}
.nbe-toc-l2 a { padding-left: 34px; }
.nbe-toc-l3 a { padding-left: 58px; }
.nbe-toc-empty {
  padding: 4px 10px;
  color: var(--nbe-placeholder);
}

/* underline — the default: gray links, each rule hugging its own text */
[data-toc-style='underline'] .nbe-toc-list a {
  display: inline-block;
  text-decoration: underline;
  text-decoration-color: var(--nbe-border);
  text-underline-offset: 5px;
  transition: background var(--nbe-fast) var(--nbe-ease), color var(--nbe-fast) var(--nbe-ease),
    text-decoration-color var(--nbe-fast) var(--nbe-ease);
}
[data-toc-style='underline'] .nbe-toc-list a:hover {
  text-decoration-color: currentColor;
}

/* rail — the vertical bar the block used to have unconditionally */
[data-toc-style='rail'] .nbe-toc-list {
  border-left: 2px solid var(--nbe-border);
}

/* numbered — 1. / 1.2. / 1.2.3., counted in CSS so the DOM stays a flat list */
[data-toc-style='numbered'] .nbe-toc-list { counter-reset: nbe-h1 nbe-h2 nbe-h3; }
[data-toc-style='numbered'] .nbe-toc-l1 { counter-increment: nbe-h1; counter-reset: nbe-h2 nbe-h3; }
[data-toc-style='numbered'] .nbe-toc-l2 { counter-increment: nbe-h2; counter-reset: nbe-h3; }
[data-toc-style='numbered'] .nbe-toc-l3 { counter-increment: nbe-h3; }
[data-toc-style='numbered'] .nbe-toc-list a::before {
  color: var(--nbe-placeholder);
  margin-right: 6px;
}
[data-toc-style='numbered'] .nbe-toc-l1 a::before { content: counter(nbe-h1) '.'; }
[data-toc-style='numbered'] .nbe-toc-l2 a::before { content: counter(nbe-h1) '.' counter(nbe-h2) '.'; }
[data-toc-style='numbered'] .nbe-toc-l3 a::before { content: counter(nbe-h1) '.' counter(nbe-h2) '.' counter(nbe-h3) '.'; }
`,
  },
};

export { tocPlugin, tocMarkdown, tocEntries, tocStyle, TOC_MARKER, TOC_STYLES } from './index';
export type { TocEntry, TocStyle } from './index';
