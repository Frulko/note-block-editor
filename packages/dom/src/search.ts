import { plainText, visibleBlocks, type BlockId } from '@nbe/core';
import type { EditorView } from './view';
import { modelPointToDom } from './selection';
import { reveal } from './viewport';
import { isMod } from './keymap';
import { createPopover, icon } from './ui';

/**
 * Find in the page, painted rather than marked up.
 *
 * @remarks
 * **Off by default, and that is the interesting decision.** In a browser
 * `⌘F` is the browser's, and taking it away from a web page to offer something
 * worse is one of the things this project's competitors are resented for. It
 * exists for the hosts where there is no browser find to take: Obsidian's
 * pane, the desktop shell. A host opts in by adding {@link findFeature} to its
 * `features`.
 *
 * The matches are `Range`s in `CSS.highlights`, the same technique the code
 * block colours with: no span is ever inserted into a leaf, so the caret, the
 * IME and the DOM→model reconciler never learn that a search happened. That is
 * what makes it safe to run while someone is typing.
 *
 * @category Interaction
 */

const ALL = 'nbe-find';
const CURRENT = 'nbe-find-current';

interface Hit {
  blockId: BlockId;
  from: number;
  to: number;
}

/** Every occurrence of `query` in the visible document, in reading order. */
export function findHits(view: EditorView, query: string): Hit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: Hit[] = [];
  for (const block of visibleBlocks(view.editor.doc)) {
    const text = plainText(block.text).toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      hits.push({ blockId: block.id, from: at, to: at + needle.length });
    }
  }
  return hits;
}

function rangeOf(view: EditorView, hit: Hit): Range | null {
  const from = modelPointToDom(view, { blockId: hit.blockId, offset: hit.from });
  const to = modelPointToDom(view, { blockId: hit.blockId, offset: hit.to });
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null; // the leaf was replaced between the model read and this frame
  }
  return range;
}

export function attachFind(view: EditorView): () => void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  // without the Highlight API a search would be invisible, and a find that
  // finds nothing you can see is worse than no find at all
  if (!highlights || !Ctor) return () => {};

  const labels = view.labels;
  let hits: Hit[] = [];
  let index = 0;
  let query = '';

  const popover = createPopover({ className: 'nbe-find' });
  const bar = document.createElement('div');
  bar.className = 'nbe-find-bar';
  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'nbe-find-field';
  field.placeholder = labels.find;
  const status = document.createElement('span');
  status.className = 'nbe-find-status';
  status.setAttribute('aria-live', 'polite');

  const step = (by: number) => {
    if (!hits.length) return;
    index = (index + by + hits.length) % hits.length;
    paint();
    const el = view.blockEl(hits[index]!.blockId);
    if (el) reveal(el);
  };

  const button = (name: 'chevron-up' | 'chevron-down' | 'x', title: string, onClick: () => void) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'nbe-find-btn';
    el.title = title;
    el.setAttribute('aria-label', title);
    el.append(icon(name, { size: 14 }));
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', onClick);
    return el;
  };

  const clear = () => {
    highlights.delete(ALL);
    highlights.delete(CURRENT);
  };

  const paint = () => {
    const ranges = hits.map((hit) => rangeOf(view, hit)).filter((r): r is Range => r !== null);
    if (!ranges.length) {
      clear();
      status.textContent = query ? labels.findNone : '';
      return;
    }
    const current = ranges[index];
    highlights.set(ALL, new Ctor(...ranges));
    if (current) highlights.set(CURRENT, new Ctor(current));
    status.textContent = `${index + 1} / ${ranges.length}`;
  };

  const search = () => {
    query = field.value;
    hits = findHits(view, query);
    index = 0;
    paint();
  };

  field.addEventListener('input', search);
  field.addEventListener('keydown', (e) => {
    // the bar owns its own keys; the editor must not also act on them
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  bar.append(
    field,
    status,
    button('chevron-up', labels.findPrevious, () => step(-1)),
    button('chevron-down', labels.findNext, () => step(1)),
    button('x', labels.findClose, () => close()),
  );
  popover.setContent(bar);

  const close = () => {
    clear();
    popover.close();
    view.content.focus({ preventScroll: true });
  };

  const open = () => {
    if (popover.isOpen) {
      field.select();
      field.focus();
      return;
    }
    // anchored to the editor's top edge, re-read so it survives a scroll
    popover.open(() => {
      const rect = view.content.getBoundingClientRect();
      return new DOMRect(rect.right - 12, rect.top + 8, 0, 0);
    }, { placement: 'bottom-end' });
    field.focus();
    field.select();
    search();
  };

  /**
   * Capture, and only while the editor has focus.
   *
   * @remarks
   * A host may already own this key — Obsidian's own search, its command
   * palette — and a listener that bubbles never sees it: the host has taken it
   * and called `preventDefault` first. So this one listens in the capture
   * phase, where it is ahead of them, and pays for that by being strict about
   * when it applies: the editor, or something inside it, has to hold focus.
   * Anywhere else in the application the key is not ours.
   */
  const mine = () => {
    const active = document.activeElement;
    return !!active && (view.content.contains(active) || popover.el.contains(active));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isMod(e) || e.key.toLowerCase() !== 'f' || e.altKey || !mine()) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  };

  document.addEventListener('keydown', onKeyDown, true);
  // the document changed under the matches: re-measure rather than leave ranges
  // pointing at text nodes a re-render replaced
  const unsubscribe = view.editor.on(() => {
    if (popover.isOpen) queueMicrotask(search);
  });

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    unsubscribe();
    clear();
    popover.close();
  };
}
