import {
  Editor,
  orphanThreads,
  documentOrder,
  threadsInDocumentOrder,
  uuidv7,
  type Block,
  type BlockId,
  type CommentStore,
} from '@nbe/core';
import {
  EditorView,
  attachRemoteCarets,
  defaultFeatures,
  fr,
  icon,
  peerSelection,
  reveal,
  wordCountFeature,
  openCommentThread,
  type CommentAuthor,
  type CommentContext,
  type RemotePeer,
  type RemoteSelection,
} from '@nbe/dom';
import { mermaidStyles } from '@nbe/blocks-mermaid';
import { mermaidFeature } from '@nbe/blocks-mermaid/dom';
import { callout } from '@nbe/blocks-callout/dom';
import { code } from '@nbe/blocks-code/dom';
import { toc } from '@nbe/blocks-toc/dom';
import { mdx } from '@nbe/blocks-mdx/dom';
import { dropZone } from '@nbe/blocks-dropzone/dom';
import { embed } from '@nbe/blocks-embed/dom';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import {
  LoroBlockStore,
  LoroComments,
  LoroHistory,
  connect,
  connectToRelay,
  createPresence,
  loopback,
  p2pTransport,
  redrawOnRemote,
} from '@nbe/collab';
import '@nbe/dom/style.css';
import './demo.css';

// the mermaid feature ships its CSS as a string, like a block plugin's `styles`
document.head.append(Object.assign(document.createElement('style'), { textContent: mermaidStyles }));

/**
 * The same block set as the single-player demo — a type that syncs but cannot
 * be typed would be a strange thing to promise, so the two demos run the same
 * list. Merging is the plugins' problem too, and this is where it shows.
 */
const BLOCKS = [callout, code, toc, mdx, dropZone, embed, ...tableDomBlocks];

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
   * The editor's own bubble, the one the single-player demo and the Obsidian
   * plugin both use. This pane used to open a `prompt()`, which could take a
   * first message and nothing after it: no replies, so a *discussion* between
   * the two people the demo exists to show was the one thing it could not do —
   * and every message it did take was written by whoever typed it with no way
   * to see who that was.
   *
   * `openCommentThread` handles the anchoring mark, the thread, replies,
   * resolving and deleting. Each pane passes its own `author`, which is what
   * puts the right name on each message in a shared store.
   */
  const commentOn = (blockId: BlockId, author: CommentAuthor | null, at?: CommentContext): void => {
    openCommentThread({ editor, store: comments, blockId, author, labels: fr, locale: 'fr', ...at });
  };

  const view = new EditorView(surface, editor, {
    onComment: commentOn,
    // the store as well: the margin badge counts *messages*, and only the store
    // knows how many — a reply adds no mark for the document to count
    commentStore: comments,
    commentAuthor: { id: person.id, name: person.name },
    labels: fr,
    blocks: BLOCKS,
    // mermaid loads itself only if a diagram is on the page; the counter is
    // cheap and answers the first question anyone asks of a shared document
    features: [...defaultFeatures, mermaidFeature, wordCountFeature],
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
    presence.set({ name: person.name, color: person.color, selection: peerSelection(editor) });
  };

  /** Everyone else, in the shape both the carets and the list want. */
  let present: RemotePeer[] = [];

  presence.onChange((peers) => {
    present = Object.entries(peers).map(([id, state]) => ({
      id,
      name: typeof state.name === 'string' ? state.name : other.name,
      color: typeof state.color === 'string' ? state.color : other.color,
      selection: (state.selection ?? null) as RemoteSelection | null,
    }));
    carets.update(present);
    renderPresence();
  });

  // --- who is here, and following one of them -------------------------------

  const peopleList = el('div', 'people');

  /**
   * The connected peers, each with what you can do about them.
   *
   * @remarks
   * Rebuilt on every presence change, which is every keystroke anyone makes —
   * so the *open* menu has to survive it. It is keyed by peer id and restored
   * after the rebuild, or opening it would be a race against the other person
   * typing.
   */
  let openMenuFor: string | null = null;

  const renderPresence = (): void => {
    peopleList.replaceChildren();
    if (!present.length) {
      peopleList.append(el('p', 'people-empty', 'Personne d’autre pour le moment.'));
      return;
    }

    for (const peer of present) {
      const row = el('div', 'person');
      const chip = el('button', 'person-chip');
      (chip as HTMLButtonElement).type = 'button';
      const dot = el('span', 'who-dot');
      dot.style.background = peer.color ?? 'currentColor';
      chip.append(dot, el('span', 'person-name', peer.name ?? 'Quelqu’un'));
      if (carets.following() === peer.id) chip.classList.add('is-followed');
      chip.addEventListener('click', () => {
        openMenuFor = openMenuFor === peer.id ? null : peer.id;
        renderPresence();
      });
      row.append(chip);

      if (openMenuFor === peer.id) {
        const menu = el('div', 'person-menu');
        const followed = carets.following() === peer.id;
        /*
         * The same button, both ways round. A separate "stop following" control
         * elsewhere would be a second thing to find for a state you can already
         * see, and the editor can end the follow on its own — a press in the
         * text does — so the label has to be read from `following()` rather
         * than from anything this list remembers.
         */
        menu.append(
          button(followed ? 'Ne plus suivre' : 'Suivre le curseur', followed ? 'x' : 'arrow-down', () => {
            carets.follow(followed ? null : peer.id);
            openMenuFor = null;
            renderPresence();
          }),
          button('Aller à sa position', 'corner-down-right', () => {
            // once, without following: "where are they" is a different question
            // from "take me with them"
            const at = peer.selection;
            const id = at ? (at.kind === 'blocks' ? at.ids[0] : (at.headBlockId ?? at.blockId)) : null;
            const target = id ? view.blockEl(id) : null;
            if (target) reveal(target, 'start');
            openMenuFor = null;
            renderPresence();
          }),
        );
        row.append(menu);
      }
      peopleList.append(row);
    }
  };

  /* The editor ends a follow by itself when this person starts reading
     somewhere else, so the list is told rather than asked. */
  carets.onFollowChange(() => renderPresence());

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
      const on = thread.blockId;
      actions.append(
        /*
         * The same bubble the margin opens, on this thread: a second way of
         * writing a reply is a second place for the author's name to be wrong.
         *
         * An orphan has no block left to anchor one to — which is what the note
         * above the card says — so it has no reply button rather than a button
         * that cannot open anything. It can still be resolved and read.
         */
        ...(on
          ? [
              button('Répondre', 'message-square', () =>
                commentOn(on, { id: person.id, name: person.name }, { threadId: thread.id }),
              ),
            ]
          : []),
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
    el('h2', undefined, 'Présents'),
    peopleList,
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
  /* The *model's* selection event, not the DOM's: a selection spanning blocks
     is one the browser refuses to hold, so `selectionchange` never fires for it
     and the peer's range would stop growing at the block boundary. */
  editor.onSelection(() => announce());

  renderComments();
  renderHistory();
  renderPresence();
}

// --- wiring -----------------------------------------------------------------

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
/*
 * A room needs a relay, and one only exists while `pnpm dev` is running — so
 * the default follows the server: a real room in development, where the dev
 * server starts a relay beside itself and a second tab is a second person; the
 * two-pane loopback in a build, which is all a static site can host. Force the
 * pair back on with `?demo=loopback`.
 */
const room = params.get('room') ?? (import.meta.env.DEV && params.get('demo') !== 'loopback' ? 'demo' : null);

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

  const bar = document.querySelector('.bar p')!;
  const say = (suffix: string): void => {
    bar.textContent = `Salon « ${name} » — ${me.name}. ${suffix}`;
  };
  say('Ouvrez la même adresse ailleurs.');
  app.style.gridTemplateColumns = '1fr';

  const store = new LoroBlockStore();
  /*
   * The relay gets you in and then gets out of the way: `p2pTransport` uses it
   * to negotiate a WebRTC data channel with the other tabs and stops sending
   * the document over it once every peer has one. Which path is live is on
   * screen on purpose — an optimisation nobody can observe is one nobody can
   * debug, and the honest version of "peer-to-peer" is a ladder with a visible
   * rung (`docs/research/p2p-any-sync.md`).
   */
  const transport = p2pTransport(connectToRelay(url, name), {
    onState: ({ peers, direct, relayed }) =>
      say(
        !peers
          ? 'Ouvrez la même adresse ailleurs.'
          : relayed
            ? `${peers} pair(s), via le relais.`
            : `${direct} pair(s) en direct — le relais ne voit plus rien.`,
      ),
  });
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
