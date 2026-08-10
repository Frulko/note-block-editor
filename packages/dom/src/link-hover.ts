import { getBlock, rangeHasMark, toggleMarkRange } from '@nbe/core';
import { mountPortal } from './ui/portal';
import type { EditorView } from './view';
import { autoUpdate, createActionButton, pushOverlay, type IconName } from './ui';
import { selectInlineText } from './selection';

/**
 * Link hover card: hovering a link offers open / copy / edit / remove without
 * having to select the text first. The card keeps itself alive while the
 * pointer travels to it, which is the whole difficulty of hover UI.
 */
export function attachLinkHover(view: EditorView): () => void {
  const editor = view.editor;
  const card = document.createElement('div');
  card.className = 'nbe-linkcard';
  card.dataset['nbeUi'] = '';
  let current: HTMLAnchorElement | null = null;
  let hideTimer = 0;
  let stopDismiss: (() => void) | null = null;
  let stopAuto: (() => void) | null = null;

  const hide = () => {
    current = null;
    stopDismiss?.();
    stopDismiss = null;
    stopAuto?.();
    stopAuto = null;
    card.remove();
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 250);
  };

  const button = (name: IconName, title: string, onClick: () => void): HTMLButtonElement =>
    createActionButton({
      title,
      icon: name,
      iconSize: 14,
      className: 'nbe-linkcard-btn',
      preserveSelection: true,
      tooltipDelay: 250,
      onClick,
    });

  const show = (anchor: HTMLAnchorElement) => {
    clearTimeout(hideTimer);
    current = anchor;
    const href = anchor.getAttribute('href') ?? '';
    card.replaceChildren();

    const label = document.createElement('a');
    label.className = 'nbe-linkcard-url';
    label.href = href;
    label.target = '_blank';
    label.rel = 'noreferrer';
    label.textContent = href.replace(/^https?:\/\//, '').slice(0, 48);
    label.title = href;
    card.append(label);

    card.append(
      button('copy', 'Copier le lien', () => {
        void navigator.clipboard?.writeText(href);
        view.announce(view.labels.linkCopied);
      }),
    );

    card.append(
      button('link', 'Modifier le lien', () => {
        if (!selectInlineText(view, anchor)) return;
        const form = document.createElement('div');
        form.className = 'nbe-linkcard-form';
        const input = document.createElement('input');
        input.className = 'nbe-db-input';
        input.value = href;
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') hide();
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const next = input.value.trim();
          if (rangeHasMark(editor, 'link')) toggleMarkRange(editor, 'link');
          if (next) toggleMarkRange(editor, 'link', { href: next });
          hide();
        });
        form.append(input);
        card.replaceChildren(form);
        input.focus();
        input.select();
      }),
    );

    card.append(
      button('x', 'Retirer le lien', () => {
        if (!selectInlineText(view, anchor)) return;
        if (rangeHasMark(editor, 'link')) toggleMarkRange(editor, 'link');
        hide();
      }),
    );

    mountPortal(card);
    // autoUpdate, not a one-shot position: switching to the edit form changes
    // the card's size and it must stay glued to the link
    stopAuto?.();
    stopAuto = autoUpdate(card, () => current?.getBoundingClientRect() ?? null, {
      placement: 'bottom-start',
      offset: 6,
    });
    stopDismiss?.();
    stopDismiss = pushOverlay({ el: card, close: hide });
  };

  const onMove = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && card.contains(target)) {
      clearTimeout(hideTimer);
      return;
    }
    const anchor = target?.closest?.('a.nbe-m-link') as HTMLAnchorElement | null;
    if (!anchor) {
      if (current) scheduleHide();
      return;
    }
    if (anchor !== current) show(anchor);
  };

  view.content.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('mousemove', onMove, { passive: true, capture: false });
  return () => {
    clearTimeout(hideTimer);
    view.content.removeEventListener('mousemove', onMove);
    document.removeEventListener('mousemove', onMove);
    hide();
  };
}
