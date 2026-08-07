import { useEffect, useRef } from 'react';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { EditorView, attachRemoteCarets } from '@nbe/dom';
import { LoroBlockStore, connect, createPresence, loopback, redrawOnRemote } from '@nbe/collab';

/**
 * Two peers, side by side, on a page that has no server.
 *
 * @remarks
 * Deliberately smaller than `examples/collab`: this shows the one thing a
 * visitor should believe in five seconds — type here, it appears there, with
 * the other person's caret where they are. Comments and version history are
 * real and live in the full example, which this page links to; putting every
 * panel here would bury the claim it exists to make.
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

  useEffect(() => {
    if (!left.current || !right.current) return;
    const [transportA, transportB] = loopback();

    const alice = new LoroBlockStore();
    const rootId = uuidv7();
    alice.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
    const seed = [
      paragraph(rootId, 'Tapez ici, puis regardez le volet d’à côté.'),
      paragraph(rootId, 'Les deux sont de vrais pairs : deux documents, une fusion.'),
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
        const selection = editor.selection;
        presence.set({
          name: person.name,
          color: person.color,
          selection:
            selection?.kind === 'text' && selection.anchor.blockId === selection.head.blockId
              ? { blockId: selection.anchor.blockId, anchor: selection.anchor.offset, head: selection.head.offset }
              : null,
        });
      };

      presence.onChange((peers) =>
        carets.update(
          Object.entries(peers).map(([id, state]) => ({
            id,
            name: String(state.name ?? ''),
            color: String(state.color ?? ''),
            selection: (state.selection ?? null) as { blockId: string; anchor: number; head: number } | null,
          })),
        ),
      );

      // a remote edit never passes through this editor, so nothing would repaint
      const stopRedraw = redrawOnRemote(store.doc, () => view.renderAll());
      editor.on(announce);
      document.addEventListener('selectionchange', announce);
      announce();

      return () => {
        document.removeEventListener('selectionchange', announce);
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

  return (
    <div className="collab-grid">
      {PEOPLE.map((person, index) => (
        <section className="collab-pane" key={person.id}>
          <header className="collab-who">
            <span className="collab-dot" style={{ background: person.color }} />
            {person.name}
          </header>
          <div ref={index === 0 ? left : right} />
        </section>
      ))}
    </div>
  );
}
