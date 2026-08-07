import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Editor, uuidv7, type Block, type BlockId } from '@nbe/core';
import { LoroBlockStore, connect, connectToRelay } from '@nbe/collab';
import { startNode } from '../src/node';
import { startRelay, type Relay } from '../src/relay';

/**
 * The headless node.
 *
 * @remarks
 * The relay tests prove that two peers who are online together converge. This
 * proves the thing a relay explicitly cannot do: **Alice writes and leaves,
 * Bob arrives afterwards, and the document is there**. Without a node the two
 * never overlap and nothing reaches Bob — which is the whole reason to run one
 * on a NAS.
 *
 * The first test below is the control: the same script against a bare relay
 * must *fail* to deliver, or the second test proves nothing.
 */

let running: Relay | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

function storeWithRoot() {
  const store = new LoroBlockStore();
  const rootId = uuidv7();
  store.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
  return { store, rootId };
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

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('délai dépassé');
}

/** Every paragraph's text in a store, so a peer's view can be compared. */
function texts(store: LoroBlockStore): string[] {
  return [...store.values()]
    .filter((block) => block.type === 'paragraph')
    .map((block) => (block.text ?? []).map((run) => run.text).join(''));
}

/** Alice connects, writes, and disconnects. Returns what she wrote. */
async function aliceWritesAndLeaves(url: string, room: string, what: string): Promise<string> {
  const { store, rootId } = storeWithRoot();
  const editor = new Editor({ doc: { blocks: store, rootId } });
  const stop = connect(store, connectToRelay(url, room));
  editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, what), index: 0 }));
  // let the write reach the other side before hanging up
  await new Promise((resolve) => setTimeout(resolve, 300));
  stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return what;
}

describe('a node keeps what a relay would drop', () => {
  it('control: through a bare relay, Bob gets nothing', async () => {
    running = await startRelay();
    const url = `ws://localhost:${running.port}`;
    await aliceWritesAndLeaves(url, 'salle', 'écrit avant que Bob existe');

    const { store: bob, rootId } = storeWithRoot();
    connect(bob, connectToRelay(url, 'salle'));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(texts(bob)).toEqual([]);
    expect(rootId).toBeTruthy();
  });

  it('through a node, Bob receives a document written before he connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbe-node-'));
    running = await startNode({ dir });
    const url = `ws://localhost:${running.port}`;
    const written = await aliceWritesAndLeaves(url, 'salle', 'écrit avant que Bob existe');

    const { store: bob } = storeWithRoot();
    connect(bob, connectToRelay(url, 'salle'));

    await until(() => texts(bob).includes(written));
    expect(texts(bob)).toContain(written);
  });

  it('and still receives it after the node restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbe-node-'));
    running = await startNode({ dir, saveDebounceMs: 50 });
    const first = `ws://localhost:${running.port}`;
    const written = await aliceWritesAndLeaves(first, 'salle', 'survit à un redémarrage');

    // the room emptied, which flushes; a snapshot must be on disk
    await until(() => readdirSync(dir).some((name) => name.endsWith('.loro')));
    await running.close();

    running = await startNode({ dir });
    const { store: bob } = storeWithRoot();
    connect(bob, connectToRelay(`ws://localhost:${running.port}`, 'salle'));

    await until(() => texts(bob).includes(written));
    expect(texts(bob)).toContain(written);
  });

  it('keeps two rooms apart, including on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbe-node-'));
    running = await startNode({ dir, saveDebounceMs: 50 });
    const url = `ws://localhost:${running.port}`;
    await aliceWritesAndLeaves(url, 'une', 'dans la première');
    await aliceWritesAndLeaves(url, 'deux', 'dans la seconde');

    await until(() => readdirSync(dir).filter((name) => name.endsWith('.loro')).length === 2);

    const { store: bob } = storeWithRoot();
    connect(bob, connectToRelay(url, 'une'));
    await until(() => texts(bob).includes('dans la première'));
    expect(texts(bob)).not.toContain('dans la seconde');
  });

  it('a room name that is a path does not escape the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbe-node-'));
    running = await startNode({ dir, saveDebounceMs: 50 });
    const url = `ws://localhost:${running.port}`;
    await aliceWritesAndLeaves(url, '../../evade', 'ne doit pas sortir');

    await until(() => readdirSync(dir).some((name) => name.endsWith('.loro')));
    // percent-encoded, so the separators are inert and the file stays put
    expect(readdirSync(dir)).toContain('..%2F..%2Fevade.loro');
  });
});

describe('a desktop-shaped client and a web-shaped one meet at the node', () => {
  it('a snapshot saved by one, reopened, converges with a fresh peer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nbe-node-'));
    running = await startNode({ dir, saveDebounceMs: 50 });
    const url = `ws://localhost:${running.port}`;

    /*
     * The desktop app's model: a document is built once, persisted as a
     * snapshot, and *reopened from that snapshot* rather than rebuilt from its
     * JSON — which is what `packages/collab/test/seeding.test.ts` shows is the
     * only shape that converges.
     */
    const first = new LoroBlockStore();
    const rootId = uuidv7();
    first.set(rootId, { id: rootId, type: 'page', version: 1, props: {}, children: [], parentId: null });
    const editor = new Editor({ doc: { blocks: first, rootId } });
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'écrit sur le bureau'), index: 0 }));
    const saved = first.doc.export({ mode: 'snapshot' });

    // the app is closed and reopened: same document, new process
    const reopened = new LoroBlockStore();
    reopened.import(saved);
    const stopDesktop = connect(reopened, connectToRelay(url, 'une-page'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // and a browser joins the same page, holding nothing
    const web = new LoroBlockStore();
    connect(web, connectToRelay(url, 'une-page'));

    await until(() => texts(web).includes('écrit sur le bureau'));
    expect(texts(web)).toEqual(['écrit sur le bureau']);

    // an edit from the browser reaches the reopened desktop document
    const webEditor = new Editor({ doc: { blocks: web, rootId } });
    webEditor.dispatch((tx) => tx.op({ type: 'insert_block', block: paragraph(rootId, 'ajouté au navigateur'), index: 1 }));

    await until(() => texts(reopened).includes('ajouté au navigateur'));
    expect(texts(reopened).sort()).toEqual(['ajouté au navigateur', 'écrit sur le bureau'].sort());
    stopDesktop();
  });
});
