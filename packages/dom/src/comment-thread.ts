import {
  anchoredThreads,
  newMessage,
  newThread,
  plainText,
  threadIdsIn,
  type BlockId,
  type CommentMessage,
  type CommentStore,
  type CommentThread,
  type Editor,
} from '@nbe/core';
import { createActionButton, createPopover, type PopoverController } from './ui';
import { defaultLabels, type EditorLabels } from './labels';
import type { CommentAuthor } from './view';

/**
 * The discussion on a block, in a bubble next to it.
 *
 * @remarks
 * The editor still does not decide *where* a discussion is displayed — that
 * remains the host's, and {@link EditorViewOptions.onComment} still hands the
 * block over and nothing else. This is a **part**, exported the way
 * `createPopover` is: a host that wants the usual bubble gets it, a host that
 * wants a sidebar ignores this file entirely.
 *
 * It exists because three hosts had each written the same composer, and each
 * had written it badly in a different way. One asked for a comment in a
 * `prompt()`. One showed the existing messages *inside the placeholder* of the
 * textarea, which is where text goes to be unreadable and unselectable. And
 * all three could only ever start a new thread: there was no way to read a
 * reply, and no way to take a comment back. A block's comments are a
 * conversation, so the panel is a conversation — messages down the page,
 * a field at the bottom, and each message removable by the person looking at
 * it.
 *
 * **Deleting a thread removes its anchor.** The marker in the margin counts
 * `comment` marks on the text rather than asking a host how many threads it
 * has (see `comment-marker.ts`), which is right — and it means the mark has to
 * go when the discussion does, or a block keeps a badge that opens onto
 * nothing. Every host's delete button was leaving one behind; they all route
 * through {@link removeCommentThread} now.
 *
 * @category Comments
 */

/** The block on screen, re-read on every reposition so a re-render cannot orphan it. */
const blockAnchor =
  (blockId: BlockId) =>
  (): DOMRect | null =>
    document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.getBoundingClientRect() ?? null;

/**
 * Lay a thread's anchor over a block's whole text, or lift it.
 *
 * @remarks
 * The whole text, because the affordance is "comment on this block" — there is
 * no hand-picked range to preserve. A block with no text takes no mark and is
 * held by `CommentThread.blockId` alone; that is the one case the hint is for.
 */
function anchor(
  editor: Editor,
  blockId: BlockId,
  threadId: string,
  add: boolean,
  range?: { from: number; to: number },
): void {
  const length = plainText(editor.doc.blocks.get(blockId)?.text).length;
  if (!length) return;
  // clamped, because the range was measured when the selection was made and
  // the block may have been edited since — a `format_text` past the end throws
  const from = Math.max(0, Math.min(range?.from ?? 0, length));
  const to = Math.max(from, Math.min(range?.to ?? length, length));
  if (from === to) return;
  editor.dispatch(
    (tx) =>
      tx.op({
        type: 'format_text',
        id: blockId,
        from,
        to,
        mark: { type: 'comment', attrs: { threadId } },
        add,
      }),
    { origin: 'ui' },
  );
}

/** Lift a thread's anchor off every block that carries it. */
function unanchor(editor: Editor, threadId: string): void {
  // every block: a thread may span several, and a comment left half-anchored
  // is a marker on a block whose discussion no longer exists
  const blocks = [...editor.doc.blocks.values()].filter((block) => threadIdsIn(block).includes(threadId));
  for (const block of blocks) anchor(editor, block.id, threadId, false);
}

/**
 * Delete a thread and the anchor that pointed at it.
 *
 * @remarks
 * Exported because a host's own comment list needs the same pair — the store
 * write alone leaves the mark, and the mark is what the margin counts.
 */
export function removeCommentThread(editor: Editor, store: CommentStore, threadId: string): void {
  store.delete(threadId);
  unanchor(editor, threadId);
}

/** @category Comments */
export interface CommentThreadOptions {
  editor: Editor;
  store: CommentStore;
  /** The block being discussed. */
  blockId: BlockId;
  /** Who is writing. `null` — the default — comments anonymously. */
  author?: CommentAuthor | null;
  /** @defaultValue the English dictionary */
  labels?: EditorLabels;
  /**
   * BCP-47 tag for the message timestamps.
   *
   * @remarks
   * Separate from {@link labels} because a dictionary is not a locale — it has
   * no tag on it to read, and `Intl` needs one. Left out, the browser's own
   * setting is used, which is right in an app and wrong in the one place a
   * host has overridden the language by hand.
   */
  locale?: string;
  /** Where to hang the panel. Defaults to the block itself. */
  getAnchor?: () => DOMRect | null;
  /**
   * Where a *new* thread's highlight goes, as character offsets in the block.
   *
   * @remarks
   * Absent means the block's whole text, which is what the gutter button has
   * always meant. Set from the format toolbar, where the point is that the
   * comment is about the sentence you selected and not about the paragraph.
   */
  range?: { from: number; to: number };
  /**
   * Show one thread rather than every thread on the block.
   *
   * @remarks
   * A block can carry several inline comments; clicking one highlight has to
   * open that discussion, not the block's whole correspondence.
   */
  threadId?: string;
}

/**
 * Open the discussion on a block. Wire it to `onComment`.
 *
 * @example
 * ```ts
 * const store = memoryComments()
 * new EditorView(el, editor, {
 *   commentAuthor: { id: 'anne', name: 'Anne' },
 *   onComment: (blockId, author) =>
 *     openCommentThread({ editor, store, blockId, author, labels: fr }),
 * })
 * ```
 *
 * @category Comments
 */
export function openCommentThread(options: CommentThreadOptions): PopoverController {
  const { editor, store, blockId, author = null, labels = defaultLabels } = options;
  const when = new Intl.DateTimeFormat(options.locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  // a synced store pushes someone else's reply into an open panel; the
  // subscription is dropped through `onClose`, which every way of closing
  // goes through — an outside press does not call `close()` on this object
  let unsubscribe: (() => void) | null = null;
  const popover = createPopover({
    className: 'nbe-comments',
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  /**
   * The threads this block is talking about.
   *
   * @remarks
   * The mark first, because the mark is the anchor. `blockId` is consulted only
   * for a thread nothing anchors — an empty block took no mark — and only while
   * no other block has claimed it, so a thread never shows up in two places.
   */
  const threadsHere = (): CommentThread[] => {
    // one highlight was clicked, or this panel started one: that discussion,
    // and only that one
    const only = options.threadId ?? started;
    if (only) {
      const one = store.get(only);
      return one ? [one] : [];
    }
    const block = editor.doc.blocks.get(blockId);
    const marked = new Set(block ? threadIdsIn(block) : []);
    const anchored = anchoredThreads(editor.doc);
    return store.list().filter((t) => marked.has(t.id) || (t.blockId === blockId && !anchored.has(t.id)));
  };

  const el = (tag: string, className: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const messageEl = (thread: CommentThread, message: CommentMessage): HTMLElement => {
    const node = el('article', 'nbe-comment');
    const head = el('div', 'nbe-comment-head');
    head.append(
      el('b', 'nbe-comment-who', message.authorName ?? labels.commentAnonymous),
      el('time', 'nbe-comment-at', when.format(new Date(message.at))),
      createActionButton({
        title: labels.commentDelete,
        icon: 'trash',
        iconSize: 13,
        className: 'nbe-comment-del',
        preserveSelection: true,
        onClick: () => {
          store.deleteMessage(thread.id, message.id);
          // the store drops a thread with its last message; the anchor is ours
          if (!store.get(thread.id)) unanchor(editor, thread.id);
          render();
        },
      }),
    );
    node.append(head, el('p', 'nbe-comment-body', message.body));
    return node;
  };

  const threadEl = (thread: CommentThread): HTMLElement => {
    const node = el('section', 'nbe-comment-thread');
    if (thread.resolved) node.dataset['resolved'] = '';
    for (const message of thread.messages) node.append(messageEl(thread, message));
    const actions = el('div', 'nbe-comment-thread-actions');
    actions.append(
      createActionButton({
        title: thread.resolved ? labels.commentReopen : labels.commentResolve,
        label: thread.resolved ? labels.commentReopen : labels.commentResolve,
        className: 'nbe-comment-btn',
        preserveSelection: true,
        onClick: () => {
          store.setResolved(thread.id, !thread.resolved);
          render();
        },
      }),
    );
    node.append(actions);
    return node;
  };

  // built once and never re-rendered: it holds what is being typed
  const list = el('div', 'nbe-comment-list');
  const compose = el('div', 'nbe-comment-compose');
  const field = document.createElement('textarea');
  field.className = 'nbe-comment-field';
  field.rows = 2;

  /**
   * The thread this panel started, if it started one.
   *
   * @remarks
   * Without it the second message typed into a freshly opened composer would
   * fork a second discussion, because the rule below says a `range` means a new
   * thread. Once one exists, this panel is about that one.
   */
  let started: string | null = null;

  const submit = (): void => {
    const body = field.value.trim();
    if (!body) return;
    field.value = '';
    const message = author ? newMessage(author.id, body, author.name) : newMessage('anon', body);
    /*
     * A reply joins the discussion that is still open; a comment on a settled
     * block starts a new one rather than reopening what someone closed.
     *
     * And a `range` always starts one. A comment made from the format toolbar
     * is *about the words that were selected*, so joining whatever else happens
     * to be anchored on the same paragraph would silently file it under someone
     * else's subject — and leave the selection with no highlight of its own.
     */
    const open = options.range && !started ? undefined : threadsHere().find((thread) => !thread.resolved);
    if (open) store.addMessage(open.id, message);
    else {
      const thread = newThread(message, blockId);
      store.create(thread);
      anchor(editor, blockId, thread.id, true, options.range);
      started = thread.id;
    }
    render();
  };

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    // the overlay stack closes on Escape; stop it reaching the editor's keymap
    if (event.key === 'Escape') event.stopPropagation();
  });

  compose.append(
    field,
    createActionButton({
      title: labels.commentSend,
      label: labels.commentSend,
      className: 'nbe-comment-btn nbe-comment-send',
      onClick: () => submit(),
    }),
  );

  function render(): void {
    const threads = threadsHere();
    list.replaceChildren(...threads.map(threadEl));
    field.placeholder = threads.length ? labels.commentReply : labels.commentPlaceholder;
  }

  render();
  const body = el('div', 'nbe-comments-body');
  body.append(list, compose);
  popover.setContent(body);
  popover.open(options.getAnchor ?? blockAnchor(blockId), { placement: 'bottom-end' });
  unsubscribe = store.onChange(render);

  // now, and again after a frame: the panel is already mounted, but WebKit
  // will not focus a node the layout has not settled on yet
  field.focus();
  requestAnimationFrame(() => field.focus());
  return popover;
}
