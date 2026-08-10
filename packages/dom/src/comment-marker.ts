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

/**
 * The distinct comment threads anchored on a block's text.
 *
 * @remarks
 * A `comment` mark carrying no `threadId` is not a discussion — it is an
 * anchor to nothing, which a hand-edited file or a half-applied paste can
 * leave behind. It used to be counted as one (under the id `''`), so a block
 * could wear a badge that opened an empty panel, and two such marks counted as
 * one thread rather than as none.
 */
export function commentThreadIds(block: Block | undefined): string[] {
  const ids = new Set<string>();
  for (const run of block?.text ?? []) {
    for (const mark of run.marks ?? []) {
      if (mark.type !== 'comment') continue;
      const id = mark.attrs?.['threadId'];
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return [...ids];
}

const CLASS = 'nbe-comment-marker';

/**
 * A `WeakMap` rather than a field on the view, the same shape `openFind` uses:
 * this is the feature's business, and a view that never attached it has
 * nothing to answer with.
 */
const refreshers = new WeakMap<EditorView, () => void>();

/**
 * Repaint the markers — for a host whose counts live outside the document.
 *
 * @remarks
 * The marker reads the *document* for how many threads a block carries, which
 * is why it needs no host API and stays right through an undo. A count that
 * comes from {@link EditorViewOptions.commentCount} does not: a reply added to
 * an existing thread changes nothing in the document, so nothing tells the
 * margin its number went up. The host that owns those messages says so here.
 *
 * @returns `false` when {@link commentMarkersFeature} is not attached.
 *
 * @category Interaction
 */
export function refreshCommentMarkers(view: EditorView): boolean {
  const refresh = refreshers.get(view);
  if (!refresh) return false;
  refresh();
  return true;
}

export function attachCommentMarkers(view: EditorView): () => void {
  const editor = view.editor;
  // no host to open a thread is no marker: a badge that does nothing when
  // pressed is worse than no badge
  if (!view.options.onComment) return () => {};

  const apply = (id: BlockId): void => {
    // queried directly rather than through `view.blockEl`, which finishes a
    // mount that is still streaming its tail: a marker is decoration, and
    // decoration must not force the rest of a long document into existence
    const el = view.content.querySelector<HTMLElement>(`.nbe-block[data-block-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const threads = commentThreadIds(editor.doc.blocks.get(id));
    // the host counts when it keeps the messages; the document knows the
    // threads, and a thread is the least a marker can honestly claim
    const count = threads.length ? (view.options.commentCount?.(id, threads) ?? threads.length) : 0;
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
        view.options.onComment?.(id, view.options.commentAuthor ?? null, {
          getAnchor: () => (button.isConnected ? button.getBoundingClientRect() : null),
        });
      });
      el.append(button);
    }
    button.title = view.labels.openComments.replace('{n}', String(count));
    button.setAttribute('aria-label', button.title);
    /*
     * The number, always — including one.
     *
     * It used to be hidden at a count of one, on the reasoning that "1" is
     * noise beside an icon that already means "there is a discussion here".
     * In a note it did not read that way: the marker is small, the margin is
     * far from the text, and a badge that appears only on the second comment
     * makes the first one look like it was not recorded.
     */
    button.querySelector('.nbe-comment-count')!.textContent = String(count);
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
    view.options.onComment?.(blockId, view.options.commentAuthor ?? null, {
      threadId,
      // the highlighted words themselves: the discussion is about those
      getAnchor: () => (span!.isConnected ? span!.getBoundingClientRect() : null),
    });
  };
  view.content.addEventListener('click', onClick);

  applyAll();
  refreshers.set(view, applyAll);

  /*
   * And again after every render.
   *
   * The opening render is *streamed*: at attach time a long note has a
   * screenful of blocks in the DOM and the rest still to come, so `applyAll`
   * above marked only what happened to be there — and nothing marked the rest,
   * because the markers are otherwise driven by edits. Opening a note with
   * comments further down showed a clean margin until the reader typed
   * something, which is exactly how it was reported: "I had to add a comment
   * for the others to appear."
   *
   * `applyAll` rather than the batch, because a re-render of one block
   * (`ids`) is already covered below, and the whole-surface case hands `null`.
   */
  const offRender = view.onRender(() => applyAll());

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
    offRender();
    refreshers.delete(view);
    view.content.removeEventListener('click', onClick);
    for (const el of view.content.querySelectorAll(`.${CLASS}`)) el.remove();
  };
}
