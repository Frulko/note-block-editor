import { getBlock, rangeHasMark, textCaret, toggleMarkRange } from '@nbe/core';
import { mountPortal } from './ui/portal';
import type { EditorView } from './view';
import { autoUpdate, createActionButton, pushOverlay, type IconName } from './ui';
import { inlineTextRange, selectInlineText } from './selection';
import { shortenUrl } from './link-paste';

/** Swap a link's text, keeping the link. */
function rename(
  view: EditorView,
  at: { blockId: string; from: number; to: number },
  href: string,
  label: string,
): void {
  view.editor.dispatch(
    (tx) => {
      tx.op({ type: 'delete_text', id: at.blockId, from: at.from, to: at.to });
      tx.op({
        type: 'insert_text',
        id: at.blockId,
        offset: at.from,
        runs: [{ text: label, marks: [{ type: 'link', attrs: { href } }] }],
      });
    },
    { origin: 'ui', selection: textCaret(at.blockId, at.from + label.length) },
  );
}

/**
 * Link hover card: hovering a link offers open / copy / edit / rename / remove
 * without having to select the text first. The card keeps itself alive while
 * the pointer travels to it, which is the whole difficulty of hover UI.
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
      button('file-text', view.labels.renameLink, () => {
        const at = inlineTextRange(view, anchor);
        if (!at) return;
        const form = document.createElement('div');
        form.className = 'nbe-linkcard-form';
        const input = document.createElement('input');
        input.className = 'nbe-db-input';
        /*
         * Pre-filled with the shortened URL, then overwritten by the real title
         * if a host can go and get one.
         *
         * Not the other way round — a field that is empty until the network
         * answers is a field you cannot type in yet, and on a host with no
         * `onResolveLink` it would stay empty forever. Shortening needs nothing
         * and is already most of what was asked for; the title is the better
         * answer when it arrives, and it only replaces text nobody has touched.
         */
        input.value = shortenUrl(href);
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') hide();
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const label = input.value.trim();
          if (label) rename(view, at, href, label);
          hide();
        });
        form.append(input);
        card.replaceChildren(form);
        input.focus();
        input.select();

        const untouched = input.value;
        void Promise.resolve(view.options.onResolveLink?.(href))
          .then((meta) => {
            const title = meta?.title?.trim();
            // only if nothing has been typed in the meantime: a resolution that
            // arrives late must never overwrite what somebody is writing
            if (!title || !input.isConnected || input.value !== untouched) return;
            input.value = title;
            input.select();
          })
          .catch(() => {
            /* no title is a missing title, not a broken card */
          });
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
