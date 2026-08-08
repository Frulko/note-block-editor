import {
  anchoredThreads,
  documentOrder,
  memoryComments,
  newMessage,
  newThread,
  orphanThreads,
  plainText,
  threadsInDocumentOrder,
  type BlockId,
  type CommentStore,
  type CommentThread,
  type Editor,
} from '@nbe/core';
import type { CommentAuthor } from '@nbe/dom';

/**
 * Comments, on blocks, in the third inspector tab.
 *
 * @remarks
 * **A comment is on a block.** The affordance is the editor's right-hand
 * gutter — hover a block, click the bubble — and never a hand-picked range,
 * which is what the `onComment` host contract expresses.
 *
 * The *anchor*, though, is still a mark on the block's text, because that is
 * the one thing that survives editing: an offset would be wrong the moment
 * someone types before it, and a stored block id would be wrong the moment the
 * block is split. The mark is laid over the whole block's text, so it moves
 * with the text, and a block emptied of text drops its thread into the orphan
 * list rather than pointing at nothing.
 *
 * Threads live beside the pages (`Workspace.threads`), not inside them: the
 * anchor is already in the page, and a thread with two homes is a thread that
 * can disagree with itself.
 *
 * @module demo-comments
 */

/** Who the demo says you are. Change it and the next comment carries it. */
export const ME: CommentAuthor = { id: 'demo-user', name: 'Vous' };

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'thread-btn';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

const time = (at: number): string =>
  new Date(at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface DemoComments {
  store: CommentStore;
  /** Wire to `EditorViewOptions.onComment`. */
  comment: (editor: Editor, blockId: BlockId, author: CommentAuthor | null) => void;
  /** Repaint the panel against a document. */
  render: (editor: Editor | null) => void;
  /** How many live threads there are, for the tab's badge. */
  count: () => number;
}

/**
 * @param initial - Threads restored from storage.
 * @param onSave - Called with the full list after every change, to persist it.
 */
export function createComments(initial: CommentThread[], onSave: (threads: CommentThread[]) => void): DemoComments {
  const store = memoryComments(initial);
  const panel = document.getElementById('panel-comments')!;
  const badge = document.getElementById('comments-count')!;
  let current: Editor | null = null;

  const comment = (editor: Editor, blockId: BlockId, author: CommentAuthor | null): void => {
    const body = prompt('Votre commentaire');
    if (!body?.trim()) return;
    const message = author ? newMessage(author.id, body, author.name) : newMessage('anon', body);
    const thread = newThread(message, blockId);
    store.create(thread);

    const length = plainText(editor.doc.blocks.get(blockId)?.text).length;
    if (length > 0) {
      editor.dispatch((tx) =>
        tx.op({
          type: 'format_text',
          id: blockId,
          from: 0,
          to: length,
          mark: { type: 'comment', attrs: { threadId: thread.id } },
          add: true,
        }),
      );
    }
    render(editor);
  };

  const card = (thread: CommentThread, orphan: boolean): HTMLElement => {
    const node = el('article', `thread${thread.resolved ? ' resolved' : ''}${orphan ? ' orphan' : ''}`);
    if (orphan) node.append(el('p', 'orphan-note', 'Le bloc commenté a disparu'));

    for (const message of thread.messages) {
      const row = el('div', 'message');
      const who = el('b', 'message-who', message.authorName ?? 'Anonyme');
      row.append(who, el('time', 'message-at', time(message.at)), el('p', 'message-body', message.body));
      node.append(row);
    }

    const actions = el('div', 'thread-actions');
    actions.append(
      button('Répondre', () => {
        const body = prompt('Votre réponse');
        if (body?.trim()) store.addMessage(thread.id, newMessage(ME.id, body, ME.name));
      }),
      button(thread.resolved ? 'Rouvrir' : 'Résoudre', () => store.setResolved(thread.id, !thread.resolved)),
      button('Supprimer', () => store.delete(thread.id)),
    );
    node.append(actions);

    /* Clicking a thread scrolls to what it is about. The anchor is the mark, so
       the block is looked up by it rather than by the stored id — which is
       precisely the id `CommentThread.blockId` warns may be stale. */
    if (!orphan) {
      node.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button') || !current) return;
        const at = anchoredThreads(current.doc).get(thread.id);
        if (!at) return;
        const target = document.querySelector(`[data-block-id="${CSS.escape(at)}"]`);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target?.classList.add('nbe-flash');
        setTimeout(() => target?.classList.remove('nbe-flash'), 1200);
      });
    }
    return node;
  };

  const render = (editor: Editor | null): void => {
    current = editor;
    panel.replaceChildren();
    if (!editor) return;

    const live = threadsInDocumentOrder(editor.doc, store, documentOrder(editor.doc));
    const orphans = orphanThreads(editor.doc, store);
    badge.textContent = live.length ? String(live.length) : '';

    if (!live.length && !orphans.length) {
      panel.append(
        el('p', 'panel-empty', 'Survolez un bloc : le bouton 💬 dans la marge de droite ouvre un commentaire.'),
      );
      return;
    }
    for (const thread of live) panel.append(card(thread, false));
    for (const thread of orphans) panel.append(card(thread, true));
  };

  store.onChange(() => {
    onSave(store.list());
    render(current);
  });

  return { store, comment, render, count: () => store.list().length };
}
