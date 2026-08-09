import { pushOverlay } from './overlay';
import { autoUpdate, positionFloating, type AnchorRect, type PositionOptions } from './position';
import { mountPortal } from './portal';
import { setIcon } from './icons';

export interface MenuItem {
  kind?: 'item';
  label: string;
  icon?: string;
  /** Right-aligned hint text, such as a keyboard shortcut. */
  hint?: string;
  /**
   * Right-aligned icon, for state rather than for a shortcut.
   *
   * @remarks
   * Separate from {@link MenuItem.hint} rather than resolving one string two
   * ways: a shortcut is text and a checkmark is a picture, and a hint that
   * happened to read `x` or `check` would silently become the wrong one.
   */
  hintIcon?: string;
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

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab']);

/**
 * Floating menu primitive: positioning with flip/clamp, outside-click and
 * Arrow-key navigation (document-level capture so the menu
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
  let stopDismiss: (() => void) | null = null;
  let anchorGetter: (() => AnchorRect | null) | null = null;
  let positionOptions: PositionOptions | undefined;

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
    /*
     * `replaceChildren` detaches every child, and detaching the focused
     * element blurs it. A custom entry hosting a text field — the code block's
     * language filter, a database's value filter — therefore lost focus on the
     * *first* keystroke, because typing re-renders the filtered list. The
     * symptom is unmistakable and was reported as such: one character per
     * click. Custom entries are re-appended as the same node, so the fix is to
     * put the caret back where the browser took it from.
     */
    const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const caret =
      focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? ([focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const)
        : null;
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
          const slot = document.createElement('span');
          slot.className = 'nbe-menu-icon';
          // a Lucide name draws; anything else is a letterform and stays text
          setIcon(slot, entry.icon);
          btn.append(slot);
        }
        btn.append(entry.label);
        if (entry.hintIcon) {
          const mark = document.createElement('span');
          mark.className = 'nbe-menu-hint nbe-menu-mark';
          setIcon(mark, entry.hintIcon, 14);
          btn.append(mark);
        } else if (entry.hint) {
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
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (caret && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
        focused.setSelectionRange(caret[0], caret[1], caret[2] ?? undefined);
      }
    }
    el.querySelector('.nbe-active')?.scrollIntoView({ block: 'nearest' });
    // reposition synchronously after the content changed: a menu anchored
    // above its trigger is placed from its own height, so filtering a long
    // list down to one item must pull the box back down. Waiting for the
    // ResizeObserver leaves a visible jump — and one frame of wrong geometry
    // is exactly when the user clicks.
    reposition();
  };

  const reposition = () => {
    if (!openFlag || !anchorGetter) return;
    const rect = anchorGetter();
    if (rect) positionFloating(el, rect, positionOptions);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!openFlag || !NAV_KEYS.has(e.key)) return;
    // custom entries may host form controls (formula editors, filter values):
    // their keys belong to them, not to menu navigation — this capture-phase
    // listener would otherwise steal Enter and fire the highlighted item
    const target = e.target as HTMLElement | null;
    if (target && el.contains(target) && target.closest('input, textarea, select')) return;
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
    }
  };

  const open: MenuController['open'] = (getAnchor, position) => {
    if (openFlag) return;
    openFlag = true;
    active = 0;
    anchorGetter = getAnchor;
    positionOptions = position;
    mountPortal(el);
    render();
    // autoUpdate re-positions on content size changes too, so a menu that
    // filters down to one item stays glued to its anchor instead of floating
    stopAuto = autoUpdate(el, getAnchor, position);
    // the overlay stack owns dismissal, so a menu nested in a popover closes
    // alone instead of taking its parent down with it
    stopDismiss = pushOverlay({ el, close, exempt: opts.isOutsideExempt });
    document.addEventListener('keydown', onKeyDown, { capture: true });
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
    stopDismiss?.();
    stopDismiss = null;
    anchorGetter = null;
    document.removeEventListener('keydown', onKeyDown, { capture: true });
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
