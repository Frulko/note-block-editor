import {
  Editor,
  newMessage,
  newThread,
  orphanThreads,
  plainText,
  documentOrder,
  threadsInDocumentOrder,
  uuidv7,
  type Block,
  type BlockId,
  type CommentStore,
} from '@nbe/core';
import { EditorView, attachRemoteCarets, icon, type CommentAuthor } from '@nbe/dom';
import {
  LoroBlockStore,
  LoroComments,
  LoroHistory,
  connect,
  connectToRelay,
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

  /*
   * A comment is on a block, not on a hand-picked range — that is the product
   * decision, and it is why this hangs off the gutter rather than off the
   * selection toolbar. The anchor is still the mark `@nbe/core` documents
   * (§2.2): it covers the whole block's text, so it survives edits and merges
   * on its own, and a block emptied of text orphans its thread rather than
   * leaving it pointing at a position that no longer means anything.
   */
  const commentOn = (blockId: BlockId, author: CommentAuthor | null): void => {
    const body = prompt('Votre commentaire');
    if (!body) return;
    // anonymous is a real mode, so the fallback is a label, not a fake identity
    const message = author ? newMessage(author.id, body, author.name) : newMessage('anon', body);
    const thread = newThread(message, blockId);
    comments.create(thread);
    const length = plainText(editor.doc.blocks.get(blockId)?.text).length;
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
    renderComments();
  };

  const view = new EditorView(surface, editor, {
    onComment: commentOn,
    commentAuthor: { id: person.id, name: person.name },
  });
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
      commentList.append(el('p', 'empty', 'Survolez un bloc, puis « Commenter » dans la marge de droite.'));
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

  // commenting lives in the editor's right-hand gutter, on the block you hover
  const tools = el('div', 'tools');
  tools.append(
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
const params = new URLSearchParams(location.search);
const room = params.get('room');

if (room) roomMode(room);
else loopbackMode();

/**
 * One editor per browser, joined by a relay — `nbe relay` or `nbe serve`.
 *
 * @remarks
 * The transport is the only difference from the loopback demo below: same
 * store, same panes, same presence. Open the page twice with the same `?room=`
 * and the second tab is a peer, not a mirror.
 */
function roomMode(name: string): void {
  const url = params.get('relay') ?? `ws://${location.hostname || 'localhost'}:8787`;
  const me: Person = {
    id: uuidv7(),
    name: params.get('name') ?? `Invité ${Math.floor(Math.random() * 900 + 100)}`,
    color: `hsl(${Math.floor(Math.random() * 360)} 65% 45%)`,
  };
  const anyone: Person = { id: '', name: 'Quelqu’un', color: 'rgb(120, 120, 120)' };

  document.querySelector('.bar p')!.textContent = `Salon « ${name} » — ${me.name}. Ouvrez la même adresse ailleurs.`;
  app.style.gridTemplateColumns = '1fr';

  const store = new LoroBlockStore();
  const transport = connectToRelay(url, name);
  connect(store, transport);

  /*
   * The root has to be the same block for everyone, so it is derived from the
   * room rather than generated — two peers generating their own would render
   * two different pages that both sync correctly, which is the confusing kind
   * of broken. The delay lets an existing document arrive before we decide the
   * room is empty; a relay with no persistence has nothing to send, and then
   * whoever is first creates it.
   *
   * ponytail: a fixed delay, not a handshake. Move to a "synced" event from
   * `connect` if a slow link ever makes an empty page flash.
   */
  const id = `${name}-root`;
  setTimeout(() => {
    if (!store.get(id)) {
      store.set(id, { id, type: 'page', version: 1, props: { title: name }, children: [], parentId: null });
      // one empty paragraph, because a page with no block has nowhere to type
      const first = paragraph(id, '');
      store.set(first.id, first);
      store.set(id, { ...store.get(id)!, children: [first.id] });
    }
    pane(app, me, anyone, store, transport, id, new LoroComments(store.doc), new LoroHistory(store));
  }, 400);
}

/** Two peers in one page, no server — what a static site can demonstrate. */
function loopbackMode(): void {
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
}
