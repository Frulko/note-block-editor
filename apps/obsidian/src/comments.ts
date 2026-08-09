import {
  memoryComments,
  newMessage,
  newThread,
  plainText,
  type BlockId,
  type BlockJSON,
  type CommentStore,
  type CommentThread,
  type Editor,
  type Run,
} from '@nbe/core';
import { createPopover, type CommentAuthor } from '@nbe/dom';

/**
 * Comments in a vault, kept in the note itself.
 *
 * @remarks
 * The plugin's own doc used to say "no comments", and the reason was real: in
 * a vault **the Markdown *is* the document**, so a thread has nowhere else to
 * live. A sidecar file would work and is what most plugins do — and it is
 * exactly what this project refuses elsewhere, because a note carried to
 * another machine on a USB stick would arrive with its discussion left behind.
 *
 * So the note carries it, in Obsidian's own comment syntax, which reading mode
 * renders as nothing:
 *
 * - the **anchor** is `%%^<id>%%` at the end of the commented block's line. It
 *   travels with the block through a reorder, a rename or an edit made in
 *   another editor, which is what an index into the file cannot do.
 * - the **threads** are one `%%carnet-comments … %%` block at the end of the
 *   note, JSON, one per line.
 *
 * Both are stripped on the way in and written on the way out, here — nothing
 * in `@nbe/markdown` knows about any of it, and a note edited by a plugin that
 * has been uninstalled is still a note.
 *
 * @module
 */

/** `%%^abc123%%` — the anchor, at the end of a block's text. */
const ANCHOR = /\s*%%\^([A-Za-z0-9_-]+)%%/g;

const OPEN = '%%carnet-comments';
const CLOSE = '%%';

export interface NoteComments {
  markdown: string;
  threads: CommentThread[];
}

/**
 * Split a note into its text and its threads.
 *
 * @remarks
 * A malformed block is *kept as text* rather than dropped: a thread nobody can
 * parse is still something someone wrote, and silently deleting it on the next
 * save is the one outcome worse than showing it.
 */
export function readComments(markdown: string): NoteComments {
  const start = markdown.lastIndexOf(`\n${OPEN}`);
  if (start === -1) return { markdown, threads: [] };
  const body = markdown.slice(start + OPEN.length + 1);
  const end = body.indexOf(`\n${CLOSE}`);
  if (end === -1) return { markdown, threads: [] };
  const threads: CommentThread[] = [];
  for (const line of body.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try {
      const thread = JSON.parse(line) as CommentThread;
      if (thread?.id && Array.isArray(thread.messages)) threads.push(thread);
    } catch {
      return { markdown, threads: [] }; // unreadable: leave the note alone
    }
  }
  return { markdown: markdown.slice(0, start), threads };
}

/** Put the threads back at the end of the note, or leave it as it is. */
export function writeComments(markdown: string, threads: readonly CommentThread[]): string {
  if (!threads.length) return markdown;
  const lines = threads.map((thread) => JSON.stringify(thread)).join('\n');
  return `${markdown.replace(/\s*$/, '')}\n\n${OPEN}\n${lines}\n${CLOSE}\n`;
}

/** Strip the anchors from parsed blocks, turning each into a `comment` mark. */
export function applyAnchors(blocks: BlockJSON[]): BlockJSON[] {
  const walk = (list: BlockJSON[]): BlockJSON[] =>
    list.map((block) => {
      const runs = block.text ?? [];
      const ids = new Set<string>();
      const text: Run[] = runs.map((run) => {
        const cleaned = run.text.replace(ANCHOR, (_, id: string) => {
          ids.add(id);
          return '';
        });
        return cleaned === run.text ? run : { ...run, text: cleaned };
      });
      const kept = text.filter((run) => run.text.length > 0);
      const marks = [...ids].map((id) => ({ type: 'comment', attrs: { threadId: id } }));
      return {
        ...block,
        ...(ids.size
          ? { text: kept.map((run) => ({ ...run, marks: [...(run.marks ?? []), ...marks] })) }
          : { text: runs }),
        ...(block.children?.length ? { children: walk(block.children) } : {}),
      };
    });
  return walk(blocks);
}

/** The distinct threads anchored on a block's text. */
function threadIdsOf(block: BlockJSON): string[] {
  const ids = new Set<string>();
  for (const run of block.text ?? []) {
    for (const mark of run.marks ?? []) {
      if (mark.type === 'comment' && typeof mark.attrs?.['threadId'] === 'string') {
        ids.add(mark.attrs['threadId'] as string);
      }
    }
  }
  return [...ids];
}

/**
 * Put the anchors back into the blocks, before they are serialised.
 *
 * @remarks
 * A plain text run appended to the block, so `blocksToMarkdown` writes it
 * without needing to know what a comment is — the alternative was teaching the
 * Markdown package a syntax only one host uses.
 */
export function restoreAnchors(blocks: BlockJSON[]): BlockJSON[] {
  const walk = (list: BlockJSON[]): BlockJSON[] =>
    list.map((block) => {
      const ids = threadIdsOf(block);
      const marker = ids.map((id) => ` %%^${id}%%`).join('');
      return {
        ...block,
        ...(marker ? { text: [...(block.text ?? []), { text: marker }] } : {}),
        ...(block.children?.length ? { children: walk(block.children) } : {}),
      };
    });
  return walk(blocks);
}

/**
 * The composer: the same floating panel the editor uses for its own chrome.
 *
 * @remarks
 * Not `prompt()`, for the reasons the demo's version records — it steals
 * focus, cannot show what is being commented on, and on a phone is a
 * full-screen sheet. Obsidian on mobile is a phone.
 */
function askForText(
  anchor: () => DOMRect | null,
  labels: { placeholder: string; submit: string },
  onSubmit: (body: string) => void,
): void {
  const popover = createPopover({ className: 'comment-compose' });
  const form = document.createElement('div');
  form.className = 'compose';
  const field = document.createElement('textarea');
  field.className = 'compose-field';
  field.rows = 3;
  field.placeholder = labels.placeholder;
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'thread-btn compose-send';
  send.textContent = labels.submit;

  const submit = () => {
    const body = field.value.trim();
    popover.close();
    if (body) onSubmit(body);
  };
  send.addEventListener('click', submit);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape') event.stopPropagation();
  });

  form.append(field, send);
  popover.setContent(form);
  popover.open(anchor, { placement: 'bottom-end' });
  field.focus();
  requestAnimationFrame(() => field.focus());
}

export interface NoteCommentHost {
  store: CommentStore;
  /** Wire to `EditorViewOptions.onComment`. */
  onComment: (editor: Editor, blockId: BlockId, author: CommentAuthor | null) => void;
}

/**
 * @param initial - Threads read out of the note.
 * @param onChange - Called after every change, so the view can mark the file dirty.
 */
export function createNoteComments(initial: CommentThread[], onChange: () => void): NoteCommentHost {
  const store = memoryComments(initial);
  store.onChange(onChange);

  const onComment = (editor: Editor, blockId: BlockId, author: CommentAuthor | null): void => {
    const anchor = () =>
      document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.getBoundingClientRect() ?? null;
    const existing = store
      .list()
      .filter((thread) => thread.blockId === blockId)
      .flatMap((thread) => thread.messages.map((m) => `${m.authorName ?? 'Anonyme'} : ${m.body}`));

    askForText(
      anchor,
      {
        placeholder: existing.length ? `${existing.join('\n')}\n—\nRépondre…` : 'Votre commentaire…',
        submit: existing.length ? 'Répondre' : 'Commenter',
      },
      (body) => {
        const message = author ? newMessage(author.id, body, author.name) : newMessage('anon', body);
        const open = store.list().find((thread) => thread.blockId === blockId && !thread.resolved);
        if (open) {
          store.addMessage(open.id, message);
          return;
        }
        const thread = newThread(message, blockId);
        store.create(thread);
        // the anchor is a mark over the block's whole text: it is what survives
        // the block being edited, split or moved, where an offset would not
        const length = plainText(editor.doc.blocks.get(blockId)?.text).length;
        if (length > 0) {
          editor.dispatch(
            (tx) =>
              tx.op({
                type: 'format_text',
                id: blockId,
                from: 0,
                to: length,
                mark: { type: 'comment', attrs: { threadId: thread.id } },
                add: true,
              }),
            { origin: 'ui' },
          );
        }
      },
    );
  };

  return { store, onComment };
}
