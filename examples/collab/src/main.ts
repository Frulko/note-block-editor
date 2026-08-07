import {
  Editor,
  newMessage,
  newThread,
  orphanThreads,
  documentOrder,
  threadsInDocumentOrder,
  toggleMarkRange,
  uuidv7,
  type Block,
  type BlockId,
  type CommentStore,
} from '@nbe/core';
import { EditorView, attachRemoteCarets, icon } from '@nbe/dom';
import {
  LoroBlockStore,
  LoroComments,
  LoroHistory,
  connect,
  createPresence,
  loopback,
  redrawOnRemote,
} from '@nbe/collab';
import '@nbe/dom/style.css';
import './demo.css';

/**
 * Two people, one document — the whole of phase 5, visible.
 *
 * @remarks
 * **Both panes are real peers.** Not one editor rendered twice: two
 * `LoroBlockStore`s, each with its own document, joined by a transport. The
 * loopback is asynchronous on purpose, so what you see is a real merge with
 * real ordering rather than a shared object mutated in place — if convergence
 * were broken, this demo would show it.
 *
 * A relay would change one line (`connectToRelay` instead of `loopback`), and
 * that is the point of the transport being an interface. A page on a static
 * site should not need a server to demonstrate merging.
 *
 * **Comments and history sit in the same document**, so they arrive with the
 * text rather than over a second channel that could lag behind it.
 *
 * @module demo-collab
 */

interface Person {
  id: string;
  name: string;
  color: string;
}

/** Blue ink and red pen — the charter, applied to people. */
const PEOPLE: [Person, Person] = [
  { id: 'a', name: 'Alice', color: 'rgb(41, 78, 199)' },
  { id: 'b', name: 'Basile', color: 'rgb(199, 58, 52)' },
];

const paragraph = (parentId: BlockId, text: string): Block => ({
  id: uuidv7(),
  type: 'paragraph',
  version: 1,
  props: {},
  children: [],
  parentId,
  text: text ? [{ text }] : [],
});

const heading = (parentId: BlockId, text: string): Block => ({
  id: uuidv7(),
  type: 'heading',
  version: 1,
  props: { level: 2 },
  children: [],
  parentId,
  text: [{ text }],
});

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, iconName: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = 'panel-btn';
  node.type = 'button';
  node.append(icon(iconName, { size: 14 }), label);
  node.addEventListener('click', onClick);
  return node;
}

/** One pane: an editor, its peer's carets, and its own panels. */
function pane(
  host: HTMLElement,
  person: Person,
  other: Person,
  store: LoroBlockStore,
  transport: ReturnType<typeof loopback>[number],
  rootId: BlockId,
  comments: CommentStore,
  history: LoroHistory,
): void {
  const wrap = el('section', 'pane');
  const head = el('div', 'pane-head');
  const dot = el('span', 'who-dot');
  dot.style.background = person.color;
  head.append(dot, el('span', 'who', person.name));
  wrap.append(head);

  const surface = el('div', 'surface');
  wrap.append(surface);

  const side = el('aside', 'side');
  wrap.append(side);
  host.append(wrap);

  const editor = new Editor({ doc: { blocks: store, rootId } });
  const view = new EditorView(surface, editor, {});
  const carets = attachRemoteCarets(view);

  /* A remote edit lands in the store without passing through this editor, so
     nothing would repaint it. Convergence would still be correct and the screen
     would still be wrong. */
  redrawOnRemote(store.doc, () => {
    view.renderAll();
    renderComments();
    renderHistory();
  });

  const presence = createPresence(transport, { id: person.id });
  presence.set({ name: person.name, color: person.color, selection: null });

  /* Announce where this person is, whenever that changes. Presence never
     touches the document — it rides the same socket and nothing more. */
  const announce = (): void => {
    const selection = editor.selection;
    presence.set({
      name: person.name,
      color: person.color,
      selection:
        selection?.kind === 'text' && selection.anchor.blockId === selection.head.blockId
          ? {
              blockId: selection.anchor.blockId,
              anchor: selection.anchor.offset,
              head: selection.head.offset,
            }
          : null,
    });
  };

  presence.onChange((peers) => {
    carets.update(
      Object.entries(peers).map(([id, state]) => ({
        id,
        name: typeof state.name === 'string' ? state.name : other.name,
        color: typeof state.color === 'string' ? state.color : other.color,
        selection: (state.selection ?? null) as { blockId: string; anchor: number; head: number } | null,
      })),
    );
  });

  // --- comments -------------------------------------------------------------

  const commentList = el('div', 'threads');

  const renderComments = (): void => {
    commentList.replaceChildren();
    // reading order, not the store's iteration order — they differ
    const order = documentOrder(editor.doc);
    const live = threadsInDocumentOrder(editor.doc, comments, order);
    const orphans = orphanThreads(editor.doc, comments);

    if (!live.length && !orphans.length) {
      commentList.append(el('p', 'empty', 'Sélectionnez du texte, puis « Commenter ».'));
      return;
    }

    for (const thread of [...live, ...orphans]) {
      const card = el('article', `thread${thread.resolved ? ' resolved' : ''}${orphans.includes(thread) ? ' orphan' : ''}`);
      if (orphans.includes(thread)) card.append(el('p', 'orphan-note', 'Le texte commenté a disparu'));
      for (const message of thread.messages) {
        const row = el('div', 'message');
        row.append(el('b', undefined, message.authorName ?? message.author), el('span', undefined, message.body));
        card.append(row);
      }
      const actions = el('div', 'thread-actions');
      actions.append(
        button('Répondre', 'message-square', () => {
          const body = prompt('Votre réponse');
          if (body) comments.addMessage(thread.id, newMessage(person.id, body, person.name));
        }),
        button(thread.resolved ? 'Rouvrir' : 'Résoudre', 'check', () =>
          comments.setResolved(thread.id, !thread.resolved),
        ),
      );
      card.append(actions);
      commentList.append(card);
    }
  };

  // --- history --------------------------------------------------------------

  const historyList = el('div', 'versions');

  const renderHistory = (): void => {
    historyList.replaceChildren();
    const marks = history.checkpoints();
    if (!marks.length) {
      historyList.append(el('p', 'empty', 'Aucune version nommée.'));
      return;
    }
    for (const mark of marks) {
      const row = el('div', 'version');
      row.append(
        el('span', 'version-name', mark.message ?? 'Sans nom'),
        el('time', 'version-at', new Date(mark.at).toLocaleTimeString('fr-FR')),
        button('Restaurer', 'undo-2', () => history.restore(mark.frontiers)),
      );
      historyList.append(row);
    }
  };

  // --- panels ---------------------------------------------------------------

  const tools = el('div', 'tools');
  tools.append(
    button('Commenter', 'message-square', () => {
      const selection = editor.selection;
      if (selection?.kind !== 'text') return alert('Sélectionnez d’abord du texte.');
      const body = prompt('Votre commentaire');
      if (!body) return;
      const thread = newThread(newMessage(person.id, body, person.name), selection.anchor.blockId);
      comments.create(thread);
      toggleMarkRange(editor, 'comment', { threadId: thread.id });
    }),
    button('Nommer cette version', 'clock', () => {
      const name = prompt('Nom de la version');
      if (name) history.checkpoint(name);
      renderHistory();
    }),
  );

  side.append(
    tools,
    el('h2', undefined, 'Commentaires'),
    commentList,
    el('h2', undefined, 'Versions'),
    historyList,
  );

  comments.onChange(renderComments);
  editor.on(() => {
    announce();
    renderComments();
    renderHistory();
  });
  document.addEventListener('selectionchange', announce);

  renderComments();
  renderHistory();
}

// --- wiring -----------------------------------------------------------------

const app = document.getElementById('app')!;
const [left, right] = loopback();

const alice = new LoroBlockStore();
const rootId = uuidv7();
alice.set(rootId, { id: rootId, type: 'page', version: 1, props: { title: 'Notes' }, children: [], parentId: null });

const seed = [
  heading(rootId, 'Réunion de lancement'),
  paragraph(rootId, 'Tapez dans un volet et regardez l’autre. Les deux sont de vrais pairs.'),
  paragraph(rootId, 'Sélectionnez une phrase, puis « Commenter » — l’ancre suit le texte.'),
];
for (const block of seed) alice.set(block.id, block);
alice.set(rootId, { ...alice.get(rootId)!, children: seed.map((block) => block.id) });

const basile = new LoroBlockStore();
connect(alice, left);
connect(basile, right);

/*
 * Basile starts empty and receives the document, which is the honest order —
 * a peer joining a session is exactly this, and seeding both sides would hide
 * whether the handshake works.
 */
setTimeout(() => {
  pane(app, PEOPLE[0], PEOPLE[1], alice, left, rootId, new LoroComments(alice.doc), new LoroHistory(alice));
  pane(app, PEOPLE[1], PEOPLE[0], basile, right, rootId, new LoroComments(basile.doc), new LoroHistory(basile));
}, 50);
