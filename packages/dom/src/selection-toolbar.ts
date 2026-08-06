import type { Mark } from '@nbe/core';
import { getBlock, hasMark, isCollapsed, sliceRuns, toggleMark, turnInto } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, positionFloating, type AnchorRect, type MenuEntry } from './ui';
import { COLORS } from './colors';
import { isActiveTarget, TURN_INTO } from './block-types';

/**
 * Floating format toolbar on text selection (Medium / Notion). It never takes
 * focus — every control preventDefaults mousedown — so the selection it acts
 * on stays alive while the user clicks it.
 */

interface FormatButton {
  mark: string;
  label: string;
  title: string;
  className?: string;
}

const FORMATS: FormatButton[] = [
  { mark: 'bold', label: 'B', title: 'Gras · ⌘B', className: 'nbe-fmt-bold' },
  { mark: 'italic', label: 'i', title: 'Italique · ⌘I', className: 'nbe-fmt-italic' },
  { mark: 'underline', label: 'U', title: 'Souligné · ⌘U', className: 'nbe-fmt-underline' },
  { mark: 'strike', label: 'S', title: 'Barré · ⌘⇧S', className: 'nbe-fmt-strike' },
  { mark: 'code', label: '<>', title: 'Code · ⌘E', className: 'nbe-fmt-code' },
];

export function attachSelectionToolbar(view: EditorView): () => void {
  const editor = view.editor;
  const bar = document.createElement('div');
  bar.className = 'nbe-seltoolbar';
  bar.dataset['nbeUi'] = '';
  bar.setAttribute('role', 'toolbar');
  let visible = false;
  let suppressed = false; // while a sub-menu of the toolbar is open

  const range = (): { blockId: string; from: number; to: number } | null => {
    const sel = editor.selection;
    if (sel?.kind !== 'text' || isCollapsed(sel)) return null;
    if (sel.anchor.blockId !== sel.head.blockId) return null;
    if (!editor.doc.blocks.has(sel.anchor.blockId)) return null;
    return {
      blockId: sel.anchor.blockId,
      from: Math.min(sel.anchor.offset, sel.head.offset),
      to: Math.max(sel.anchor.offset, sel.head.offset),
    };
  };

  const anchorRect = (): AnchorRect | null => {
    const dom = document.getSelection();
    if (!dom || dom.rangeCount === 0) return null;
    const rect = dom.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  };

  const button = (label: string, title: string, onClick: () => void, className = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `nbe-seltoolbar-btn ${className}`.trim();
    b.title = title;
    b.append(label);
    // never let the toolbar steal the selection it is acting on
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  };

  const applyMark = (type: string, attrs?: Record<string, unknown>) => {
    toggleMark(editor, type, attrs);
    render(); // active states change in place
    view.syncDomSelection();
  };

  const openSubMenu = (anchor: HTMLElement, entries: MenuEntry[]) => {
    suppressed = true;
    const menu = createMenu({
      className: 'nbe-seltoolbar-menu',
      onClose: () => {
        suppressed = false;
        update();
      },
    });
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  const colorEntries = (r: { blockId: string; from: number; to: number }): MenuEntry[] => {
    const entries: MenuEntry[] = [{ kind: 'section', label: 'Couleur du texte' }];
    const swatchRow = (kind: 'color' | 'background') => {
      const row = document.createElement('div');
      row.className = 'nbe-menu-swatches';
      for (const c of COLORS) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'nbe-swatch';
        sw.title = c.label;
        sw.textContent = 'A';
        if (kind === 'color') sw.style.color = c.text;
        else {
          sw.style.background = c.background;
          if (c.name === 'default') sw.style.color = 'rgba(55,53,47,0.4)';
        }
        sw.addEventListener('mousedown', (e) => e.preventDefault());
        sw.addEventListener('click', () => {
          const markType = kind === 'color' ? 'color' : 'background';
          if (c.name === 'default') {
            // removing means toggling the existing mark off
            const block = getBlock(editor.doc, r.blockId);
            if (hasMark(block.text ?? [], r.from, r.to, markType)) applyMark(markType);
          } else {
            const block = getBlock(editor.doc, r.blockId);
            const already = sliceRuns(block.text ?? [], r.from, r.to).every((run) =>
              (run.marks ?? []).some((m: Mark) => m.type === markType && m.attrs?.['color'] === c.name),
            );
            if (already) applyMark(markType);
            else {
              // replace any existing colour of the same kind in one step
              if (hasMark(block.text ?? [], r.from, r.to, markType)) applyMark(markType);
              applyMark(markType, { color: c.name });
            }
          }
        });
        row.append(sw);
      }
      return row;
    };
    entries.push({ kind: 'custom', el: swatchRow('color') });
    entries.push({ kind: 'section', label: 'Surlignage' });
    entries.push({ kind: 'custom', el: swatchRow('background') });
    return entries;
  };

  const linkEntry = (r: { blockId: string; from: number; to: number }): MenuEntry => {
    const wrap = document.createElement('div');
    wrap.className = 'nbe-seltoolbar-linkform';
    const input = document.createElement('input');
    input.className = 'nbe-db-input';
    input.placeholder = 'https://…';
    const block = getBlock(editor.doc, r.blockId);
    const existing = sliceRuns(block.text ?? [], r.from, r.to)[0]?.marks?.find((m: Mark) => m.type === 'link');
    input.value = String(existing?.attrs?.['href'] ?? '');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const href = input.value.trim();
      if (hasMark(block.text ?? [], r.from, r.to, 'link')) applyMark('link');
      if (href) applyMark('link', { href });
    });
    wrap.append(input);
    return { kind: 'custom', el: wrap };
  };

  const render = () => {
    const r = range();
    if (!r) return;
    const block = getBlock(editor.doc, r.blockId);
    const runs = block.text ?? [];
    bar.replaceChildren();

    // turn-into (only for blocks that carry inline text)
    const turnBtn = button(
      `${TURN_INTO.find((t) => isActiveTarget(t, block))?.label ?? 'Texte'} ▾`,
      'Transformer en',
      () =>
        openSubMenu(
          turnBtn,
          TURN_INTO.map((t) => ({
            label: t.label,
            icon: t.icon,
            hint: isActiveTarget(t, block) ? '✓' : undefined,
            onSelect: () => turnInto(editor, block.id, t.type, t.props),
          })),
        ),
      'nbe-seltoolbar-turn',
    );
    bar.append(turnBtn, divider());

    for (const fmt of FORMATS) {
      const active = hasMark(runs, r.from, r.to, fmt.mark);
      const b = button(fmt.label, fmt.title, () => applyMark(fmt.mark), fmt.className);
      if (active) b.classList.add('nbe-active');
      bar.append(b);
    }

    const linkActive = hasMark(runs, r.from, r.to, 'link');
    const linkBtn = button('🔗', 'Lien · ⌘K', () => openSubMenu(linkBtn, [linkEntry(r)]), 'nbe-seltoolbar-link');
    if (linkActive) linkBtn.classList.add('nbe-active');
    bar.append(linkBtn, divider());

    const colorBtn = button('A ▾', 'Couleur et surlignage', () => openSubMenu(colorBtn, colorEntries(r)), 'nbe-seltoolbar-color');
    bar.append(colorBtn);
  };

  const divider = (): HTMLElement => {
    const d = document.createElement('span');
    d.className = 'nbe-seltoolbar-sep';
    return d;
  };

  const show = () => {
    const rect = anchorRect();
    if (!rect) return hide();
    if (!visible) {
      document.body.append(bar);
      visible = true;
    }
    render();
    positionFloating(bar, rect, { placement: 'top-start', offset: 8 });
  };

  const hide = () => {
    if (!visible) return;
    visible = false;
    bar.remove();
  };

  const update = () => {
    if (suppressed) return;
    if (range()) show();
    else hide();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && visible && !suppressed) hide();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && range()) {
      e.preventDefault();
      const r = range()!;
      const btn = bar.querySelector('.nbe-seltoolbar-link') as HTMLElement | null;
      if (btn) openSubMenu(btn, [linkEntry(r)]);
    }
  };

  const unsubSelection = editor.onSelection(() => update());
  const unsubChange = editor.on(() => update());
  // mouse-driven selections settle on mouseup; selectionchange fires mid-drag
  const onMouseUp = () => setTimeout(update, 0);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('scroll', update, { capture: true, passive: true });
  window.addEventListener('resize', update);
  view.content.addEventListener('keydown', onKeyDown);

  return () => {
    unsubSelection();
    unsubChange();
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('scroll', update, { capture: true });
    window.removeEventListener('resize', update);
    view.content.removeEventListener('keydown', onKeyDown);
    hide();
  };
}
