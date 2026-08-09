import type { Block, BlockId } from '@nbe/core';
import { visibleBlocks } from '@nbe/core';
import type { EditorView } from './view';
import { icon } from './ui';

/**
 * A block that has been commented says so, without being hovered.
 *
 * @remarks
 * The affordance for *making* a comment lives in the hover gutter, which is
 * right: an action you might take belongs where you are pointing. But a
 * comment that already exists is a fact about the document, and a fact nobody
 * can see until they happen to hover the right block might as well not be
 * recorded. So a commented block carries a marker in the right margin, always.
 *
 * **No host API for the count.** The editor already knows: a thread anchors
 * itself as a `comment` mark carrying its `threadId` (that is what survives
 * editing, where an offset or a block id would not), so counting the distinct
 * ids on a block's text is counting its threads. A `commentCount` option would
 * have been a second source for something the document already says.
 *
 * A feature rather than part of `renderBlock`, because the marker has to
 * survive a re-render of a *different* block — and because a host that does
 * not do comments should not ship it.
 *
 * @category Interaction
 */

/** The distinct comment threads anchored on a block's text. */
export function commentThreadIds(block: Block | undefined): string[] {
  const ids = new Set<string>();
  for (const run of block?.text ?? []) {
    for (const mark of run.marks ?? []) {
      if (mark.type !== 'comment') continue;
      const id = mark.attrs?.['threadId'];
      ids.add(typeof id === 'string' ? id : '');
    }
  }
  return [...ids];
}

const CLASS = 'nbe-comment-marker';

export function attachCommentMarkers(view: EditorView): () => void {
  const editor = view.editor;
  // no host to open a thread is no marker: a badge that does nothing when
  // pressed is worse than no badge
  if (!view.options.onComment) return () => {};

  const apply = (id: BlockId): void => {
    const el = view.blockEl(id);
    if (!el) return;
    const count = commentThreadIds(editor.doc.blocks.get(id)).length;
    const existing = el.querySelector<HTMLButtonElement>(`:scope > .${CLASS}`);
    if (!count) {
      existing?.remove();
      delete el.dataset['comments'];
      return;
    }
    el.dataset['comments'] = '';
    const button: HTMLButtonElement = existing ?? document.createElement('button');
    if (!existing) {
      button.type = 'button';
      button.className = CLASS;
      button.setAttribute('contenteditable', 'false');
      button.append(icon('message-square', { size: 15 }));
      const badge = document.createElement('span');
      badge.className = 'nbe-comment-count';
      button.append(badge);
      // `mousedown` would move the caret out of the block being discussed
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        view.options.onComment?.(id, view.options.commentAuthor ?? null);
      });
      el.append(button);
    }
    button.title = view.labels.openComments.replace('{n}', String(count));
    button.setAttribute('aria-label', button.title);
    // a single thread needs no number; a count of one is noise
    button.querySelector('.nbe-comment-count')!.textContent = count > 1 ? String(count) : '';
  };

  const applyAll = (): void => {
    for (const block of visibleBlocks(editor.doc)) apply(block.id);
  };

  /**
   * Clicking a yellow highlight opens the discussion it stands for.
   *
   * @remarks
   * The stylesheet has drawn this span with `cursor: pointer` since comments
   * shipped and nothing was listening — the mark's `threadId` did not reach the
   * DOM, so there was no way to know *which* discussion had been clicked. It
   * does now (`renderRun`), and a block can carry several.
   *
   * `click`, not `mousedown`: a press is also how a caret is placed, and
   * commented text has to stay editable.
   */
  const onClick = (event: MouseEvent): void => {
    const span = (event.target as HTMLElement | null)?.closest?.('.nbe-m-comment') as HTMLElement | null;
    const threadId = span?.dataset['threadId'];
    if (!threadId) return;
    const blockId = span!.closest<HTMLElement>('.nbe-block')?.dataset['blockId'];
    if (!blockId || !editor.doc.blocks.has(blockId)) return;
    view.options.onComment?.(blockId, view.options.commentAuthor ?? null, { threadId });
  };
  view.content.addEventListener('click', onClick);

  applyAll();

  const unsubscribe = editor.on((change) => {
    const structural = change.ops.some((op) => op.type !== 'insert_text' && op.type !== 'delete_text');
    const dirty = [...change.dirty];
    /*
     * After the view has repainted the blocks this change dirtied, or the
     * marker is appended to an element that is about to be thrown away. One
     * microtask, so it is still the same frame.
     */
    queueMicrotask(() => {
      if (structural) applyAll();
      else for (const id of dirty) apply(id);
    });
  });

  return () => {
    unsubscribe();
    view.content.removeEventListener('click', onClick);
    for (const el of view.content.querySelectorAll(`.${CLASS}`)) el.remove();
  };
}
