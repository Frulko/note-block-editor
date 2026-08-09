import type { BlockId } from '@nbe/core';
import { getBlock } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, createMenuFilter, type MenuEntry } from './ui';

/**
 * Point a `link_to_page` block at a page, found by searching the host.
 *
 * @remarks
 * The same `onSearchPages` the `@` mention picker uses, which is what makes
 * this work in a vault without the editor learning what a vault is: in
 * Obsidian the `pageId` **is** the note's name, because a vault resolves links
 * by name and has no ids to offer.
 *
 * `createMenuFilter` rather than a field of its own — it is the shared
 * combobox: the input keeps the typing and hands ↑↓ and Enter to the list, with
 * `aria-activedescendant` announcing the highlighted option without the focus
 * leaving the field. A picker you cannot drive from the keyboard is a picker
 * that excludes people.
 *
 * @category Interaction
 */
export function openPagePicker(view: EditorView, blockId: BlockId, anchor: () => DOMRect): void {
  const search = view.options.onSearchPages;
  if (!search) return;
  const labels = view.labels;
  const menu = createMenu({ className: 'nbe-blocktoolbar-menu nbe-pagemenu' });
  const filter = createMenuFilter({ placeholder: labels.choosePage, onInput: (q) => render(q) });

  const choose = (pageId: string, title: string) => {
    const block = view.editor.doc.blocks.get(blockId);
    if (!block) return;
    view.editor.dispatch(
      // `target` as well as `title`: the title is what is shown and a host may
      // rename it, the target is what the link resolves by
      (tx) => tx.op({ type: 'update_block', id: blockId, patch: { props: { pageId, title, target: pageId } } }),
      { origin: 'ui' },
    );
    menu.close();
  };

  const render = (query: string) => {
    const current = String(view.editor.doc.blocks.get(blockId)?.props['pageId'] ?? '');
    const found = search(query);
    const entries: MenuEntry[] = [{ kind: 'custom', el: filter.el }];
    for (const page of found.slice(0, 12)) {
      entries.push({
        label: page.title,
        icon: page.icon ?? 'file-text',
        hintIcon: page.pageId === current ? 'check' : undefined,
        onSelect: () => choose(page.pageId, page.title),
      });
    }
    if (!found.length) entries.push({ kind: 'section', label: labels.noPageFound });
    menu.update(entries);
  };

  // everything that is not navigation is typing, and must not reach the editor
  filter.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') e.stopPropagation();
  });

  render('');
  menu.open(anchor, { placement: 'bottom-start' });
  filter.focus();
}

/** The picker anchored to a block, for the slash menu and the ⋮⋮ menu alike. */
export function openPagePickerOn(view: EditorView, blockId: BlockId): void {
  openPagePicker(view, blockId, () => {
    const el = view.blockEl(blockId);
    return el ? el.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
  });
}

/** True when this block is one the picker can retarget. */
export function isPageLink(view: EditorView, id: BlockId): boolean {
  const type = getBlock(view.editor.doc, id).type;
  return type === 'link_to_page' || type === 'sub_page';
}
