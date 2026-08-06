import { autoUpdate, type AnchorRect, type PositionOptions } from './position';

export interface MenuItem {
  kind?: 'item';
  label: string;
  icon?: string;
  /** Right-aligned hint (keyboard shortcut, checkmark…). */
  hint?: string;
  onSelect: () => void;
}

export interface MenuSection {
  kind: 'section';
  label: string;
}

export interface MenuCustom {
  kind: 'custom';
  el: HTMLElement;
}

export type MenuEntry = MenuItem | MenuSection | MenuCustom;

export interface MenuController {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(getAnchor: () => AnchorRect | null, position?: PositionOptions): void;
  /** Replace entries; closes the menu when no selectable item remains. */
  update(entries: MenuEntry[]): void;
  close(): void;
}

export interface MenuOptions {
  className?: string;
  onClose?: () => void;
  /** Targets that must not count as outside clicks (e.g. the button that toggles the menu). */
  isOutsideExempt?: (target: Node) => boolean;
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);

/**
 * Floating menu primitive: positioning with flip/clamp, outside-click and
 * Escape dismissal, arrow-key navigation (document-level capture so the menu
 * wins over editor keymaps while typing continues to flow to the editor).
 */
export function createMenu(opts: MenuOptions = {}): MenuController {
  const el = document.createElement('div');
  el.className = `nbe-menu ${opts.className ?? ''}`.trim();
  el.dataset['nbeUi'] = '';
  el.setAttribute('role', 'menu');

  let entries: MenuEntry[] = [];
  let active = 0;
  let openFlag = false;
  let stopAuto: (() => void) | null = null;

  const selectable = (): MenuItem[] =>
    entries.filter((e): e is MenuItem => e.kind === undefined || e.kind === 'item');

  const select = (item: MenuItem) => {
    close();
    item.onSelect();
  };

  const render = () => {
    const items = selectable();
    active = Math.min(active, Math.max(0, items.length - 1));
    let itemIndex = -1;
    el.replaceChildren(
      ...entries.map((entry) => {
        if (entry.kind === 'section') {
          const s = document.createElement('div');
          s.className = 'nbe-menu-section';
          s.textContent = entry.label;
          return s;
        }
        if (entry.kind === 'custom') return entry.el;
        itemIndex++;
        const i = itemIndex;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nbe-menu-item' + (i === active ? ' nbe-active' : '');
        btn.setAttribute('role', 'menuitem');
        if (entry.icon) {
          const icon = document.createElement('span');
          icon.className = 'nbe-menu-icon';
          icon.textContent = entry.icon;
          btn.append(icon);
        }
        btn.append(entry.label);
        if (entry.hint) {
          const hint = document.createElement('span');
          hint.className = 'nbe-menu-hint';
          hint.textContent = entry.hint;
          btn.append(hint);
        }
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
        btn.addEventListener('click', () => select(entry));
        btn.addEventListener('mousemove', () => {
          if (active !== i) {
            active = i;
            render();
          }
        });
        return btn;
      }),
    );
    el.querySelector('.nbe-active')?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!openFlag || !NAV_KEYS.has(e.key)) return;
    // custom entries may host form controls (formula editors, filter values):
    // their keys belong to them, not to menu navigation — this capture-phase
    // listener would otherwise steal Enter and fire the highlighted item
    const target = e.target as HTMLElement | null;
    if (e.key !== 'Escape' && target && el.contains(target) && target.closest('input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const items = selectable();
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length);
        render();
        return;
      case 'Enter':
      case 'Tab': {
        const item = items[active];
        if (item) select(item);
        return;
      }
      case 'Escape':
        close();
        return;
    }
  };

  const onOutsideMouseDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (el.contains(t) || opts.isOutsideExempt?.(t)) return;
    close();
  };

  const open: MenuController['open'] = (getAnchor, position) => {
    if (openFlag) return;
    openFlag = true;
    active = 0;
    document.body.append(el);
    render();
    stopAuto = autoUpdate(el, getAnchor, position);
    document.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('mousedown', onOutsideMouseDown);
  };

  const update: MenuController['update'] = (newEntries) => {
    entries = newEntries;
    if (!openFlag) return;
    if (!selectable().length) close();
    else render();
  };

  const close = () => {
    if (!openFlag) return;
    openFlag = false;
    stopAuto?.();
    stopAuto = null;
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('mousedown', onOutsideMouseDown);
    el.remove();
    opts.onClose?.();
  };

  return {
    el,
    get isOpen() {
      return openFlag;
    },
    open,
    update,
    close,
  };
}
