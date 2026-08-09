import { useEffect, useRef, useState } from 'react';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { EditorView, attachRemoteCarets, peerSelection, type RemoteSelection } from '@nbe/dom';
import { LoroBlockStore, connect, createPresence, loopback, redrawOnRemote, type Transport } from '@nbe/collab';

/**
 * Two peers, side by side, on a page that has no server.
 *
 * @remarks
 * Deliberately smaller than `examples/collab`: it shows the two things a
 * visitor should believe in five seconds — type here and it appears there with
 * the other person's caret, and cut a peer off, write in both, rejoin, and
 * nothing is lost. Comments and version history are real and live in the full
 * example, which this page links to; putting every panel here would bury the
 * claim it exists to make.
 *
 * The panes are genuinely two documents joined by a transport, not one editor
 * rendered twice. The loopback delivers asynchronously, so a broken merge would
 * be visible rather than hidden by a shared object.
 *
 * `client:only` in the page, because the CRDT is WebAssembly and there is
 * nothing to server-render.
 */

interface Person {
  id: string;
  name: string;
  color: string;
}

/** Blue ink and red pen, from the charter. */
const PEOPLE: [Person, Person] = [
  { id: 'a', name: 'Alice', color: 'rgb(41, 78, 199)' },
  { id: 'b', name: 'Basile', color: 'rgb(199, 58, 52)' },
];

/**
 * A transport that can be cut and rejoined — the demo's whole point.
 *
 * @remarks
 * `loopback().close()` is final, so pausing is done here instead: both
 * directions are held rather than dropped, and released in order on
 * reconnection. That is what an offline peer actually is — bytes that arrive
 * late, not bytes that are lost — and it is why the two halves can be typed
 * into at the same time and still converge.
 *
 * Presence rides the same transport, so a cut peer's caret freezes on the other
 * side instead of silently pointing at a document it can no longer see.
 */
interface Gated extends Transport {
  setOnline(online: boolean): void;
}

function gate(inner: Transport): Gated {
  const handlers = new Set<(message: Uint8Array) => void>();
  const outbox: Uint8Array[] = [];
  const inbox: Uint8Array[] = [];
  let online = true;

  inner.onMessage((message) => {
    if (online) for (const handler of handlers) handler(message);
    else inbox.push(message);
  });

  return {
    send(message) {
      if (online) inner.send(message);
      else outbox.push(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    setOnline(next) {
      online = next;
      if (!next) return;
      // what we owe the other side first, then what it sent while we were away
      for (const message of outbox.splice(0)) inner.send(message);
      for (const message of inbox.splice(0)) for (const handler of handlers) handler(message);
    },
  };
}

const paragraph = (parentId: BlockId, text: string): Block => ({
  id: uuidv7(),
  type: 'paragraph',
  version: 1,
  props: {},
  children: [],
  parentId,
  text: [{ text }],
});

export default function CollabDemo() {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const gates = useRef<[Gated, Gated] | null>(null);
  const [online, setOnline] = useState<[boolean, boolean]>([true, true]);

  useEffect(() => {
    if (!left.current || !right.current) return;
    const [wireA, wireB] = loopback();
    const [transportA, transportB] = [gate(wireA), gate(wireB)];
    gates.current = [transportA, transportB];

    const alice = new LoroBlockStore();
    const rootId = uuidv7();
    alice.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
    const seed = [
      paragraph(rootId, 'Tapez ici, puis regardez le volet d’à côté.'),
      paragraph(rootId, 'Coupez un pair, écrivez dans les deux, rebranchez : rien ne se perd.'),
    ];
    for (const block of seed) alice.set(block.id, block);
    alice.set(rootId, { ...alice.get(rootId)!, children: seed.map((block) => block.id) });

    // Basile starts empty and receives the document, which is what joining is
    const basile = new LoroBlockStore();
    const stops = [connect(alice, transportA), connect(basile, transportB)];

    const mount = (host: HTMLElement, person: Person, store: LoroBlockStore, transport: typeof transportA) => {
      const editor = new Editor({ doc: { blocks: store, rootId } });
      const view = new EditorView(host, editor, {});
      const carets = attachRemoteCarets(view);
      const presence = createPresence(transport, { id: person.id });

      const announce = () => {
        presence.set({ name: person.name, color: person.color, selection: peerSelection(editor) });
      };

      presence.onChange((peers) =>
        carets.update(
          Object.entries(peers).map(([id, state]) => ({
            id,
            name: String(state.name ?? ''),
            color: String(state.color ?? ''),
            selection: (state.selection ?? null) as RemoteSelection | null,
          })),
        ),
      );

      // a remote edit never passes through this editor, so nothing would repaint
      const stopRedraw = redrawOnRemote(store.doc, () => view.renderAll());
      editor.on(announce);
      /*
       * The *model's* selection event, not the DOM's. A selection that spans
       * blocks is one the browser refuses to hold, so `selectionchange` never
       * fires for it — and listening to that was why a peer's range stopped
       * growing at the block boundary on every other screen.
       */
      const stopSelection = editor.onSelection(() => announce());
      announce();

      return () => {
        stopSelection();
        stopRedraw();
        carets.destroy();
        presence.leave();
        view.destroy();
      };
    };

    // let the handshake settle so Basile has the document before he is shown
    const teardown: Array<() => void> = [];
    const timer = setTimeout(() => {
      teardown.push(mount(left.current!, PEOPLE[0], alice, transportA));
      teardown.push(mount(right.current!, PEOPLE[1], basile, transportB));
    }, 60);

    return () => {
      clearTimeout(timer);
      for (const stop of teardown) stop();
      for (const stop of stops) stop();
    };
  }, []);

  const cut = (index: 0 | 1) => {
    const next = !online[index];
    gates.current?.[index].setOnline(next);
    setOnline(index === 0 ? [next, online[1]] : [online[0], next]);
  };

  return (
    <div className="collab-grid">
      {PEOPLE.map((person, index) => (
        <section className="collab-pane" key={person.id}>
          <header className="collab-who">
            <span className="collab-avatar" style={{ background: person.color }}>
              {person.name[0]}
            </span>
            <span className="collab-name">{person.name}</span>
            <button
              type="button"
              className="collab-net"
              data-off={online[index] ? undefined : ''}
              aria-pressed={!online[index]}
              onClick={() => cut(index as 0 | 1)}
            >
              <span className="collab-net-dot" />
              {online[index] ? 'En ligne' : 'Hors ligne'}
            </button>
          </header>
          <div className="collab-editor" ref={index === 0 ? left : right} />
        </section>
      ))}
    </div>
  );
}
