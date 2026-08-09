import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { docFromJSON, docToJSON, Editor, type BlockJSON } from '@nbe/core';
import {
  LoroBlockStore,
  LoroComments,
  connect,
  connectToRelay,
  p2pTransport,
  redrawOnRemote,
  seedFromJSON,
} from '@nbe/collab';
import {
  EditorView,
  defaultFeatures,
  exportFeature,
  findFeature,
  fr,
  openCommentThread,
  wordCountFeature,
  type CommentAuthor,
} from '@nbe/dom';
import { callout } from '@nbe/blocks-callout/dom';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import { code } from '@nbe/blocks-code/dom';
import { toc } from '@nbe/blocks-toc/dom';
import { mdx } from '@nbe/blocks-mdx/dom';
import { mermaidStyles } from '@nbe/blocks-mermaid';
import { mermaidFeature } from '@nbe/blocks-mermaid/dom';
import { Workspace, pageTitle } from '@nbe/workspace';
import { exportVault } from '@nbe/workspace/vault';
import '@nbe/dom/style.css';
import './app.css';
import { createDatabaseHost, type CollectionRecord } from '@nbe/workspace/database';
import {
  NATIVE,
  clearDirectory,
  collectionStore,
  memoryAssets,
  memorySnapshots,
  scratchCollections,
  scratchStorage,
  vaultAssets,
  vaultSnapshots,
  vaultStorage,
  writeInto,
  type AssetStore,
  type SnapshotStore,
} from './storage';

// the mermaid feature ships its CSS as a string, like a block plugin's `styles`
document.head.append(Object.assign(document.createElement('style'), { textContent: mermaidStyles }));

/** The blocks this shell runs. Activation is an import plus an array entry. */
const BLOCKS = [callout, code, toc, mdx, ...tableDomBlocks];

/**
 * The chrome, including the three features a browser host leaves off.
 *
 * @remarks
 * `find` and `export` are opt-in in `@nbe/dom` because on the web ⌘F and ⌘P
 * belong to the browser, and taking them to offer something worse is what this
 * project set out not to be. A window has neither, so here they are the
 * editor's — which is the whole reason those features are configuration rather
 * than a decision baked in.
 */
const FEATURES = [...defaultFeatures, findFeature, exportFeature, wordCountFeature, mermaidFeature];

/*
 * Theme. `data-nbe-theme` on <html> is the editor's documented host hook and
 * this shell's own tokens read the same attribute, so one property themes
 * both — and it is applied before the first render so a saved choice never
 * flashes the other way.
 */
const themeEl = document.getElementById('theme') as HTMLSelectElement | null;
if (themeEl) {
  themeEl.value = localStorage.getItem('carnet-theme') ?? '';
  const applyTheme = (): void => {
    if (themeEl.value) document.documentElement.dataset['nbeTheme'] = themeEl.value;
    else delete document.documentElement.dataset['nbeTheme'];
    localStorage.setItem('carnet-theme', themeEl.value);
  };
  applyTheme();
  themeEl.addEventListener('change', applyTheme);
}

/**
 * Carnet — a notes application whose storage is a folder you can read.
 *
 * @remarks
 * Almost nothing here is new. `@nbe/workspace` holds the page tree, search and
 * backlinks; `@nbe/dom` is the editor; `@nbe/workspace/vault` is the Markdown
 * projection. This file is the ~250 lines of application that a desktop
 * version actually requires: choosing a folder, remembering it, and drawing a
 * sidebar.
 *
 * **The folder is a real Obsidian vault**, with one qualification worth stating
 * plainly. The Markdown is the vault — one `.md` per page, children in folders
 * named after their parent. Beside it, `.nbe/` holds the canonical JSON, which
 * Obsidian ignores because it ignores dot-directories.
 *
 * Both exist because Markdown is a *projection* with documented losses (D7):
 * it cannot write an empty block, and it folds hand-wrapped paragraphs on
 * purpose. If Markdown were the only storage, those losses would compound on
 * every save. So the JSON is authoritative and the Markdown is regenerated —
 * and because it is regenerated, it is always safe to read, edit and diff.
 *
 * @category App
 */

const SETTINGS = 'carnet.json';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const sidebarEl = el('sidebar');
const editorEl = el('editor');
const pagesEl = el('pages');
const resultsEl = el('results');
const crumbsEl = el('crumbs');
const backlinksEl = el('backlinks');
const searchEl = el<HTMLInputElement>('search');
const welcomeEl = el('welcome');
const statusEl = el('status');
const vaultLabel = el('vault-label');

let root: string | null = null;
let workspace: Workspace | null = null;
/** Where each page's CRDT document is kept. */
let snapshots: SnapshotStore | null = null;
/** Where pasted and dropped files are kept. */
let assets: AssetStore | null = null;
let editor: Editor | null = null;
let view: EditorView | null = null;
let openId: string | null = null;
let database: ReturnType<typeof createDatabaseHost> | null = null;
let collections: CollectionRecord[] = [];

/**
 * Who this machine is, when it comments.
 *
 * @remarks
 * Kept in `localStorage` — per machine, not per vault. The id is what tells two
 * peers of the same document apart, so a folder copied to a second machine
 * must not carry an identity with it. The name is display only; nothing here
 * is a login, and there is no server to be one against.
 */
function whoAmI(): CommentAuthor {
  let id = localStorage.getItem('carnet.me');
  if (!id) localStorage.setItem('carnet.me', (id = crypto.randomUUID()));
  return { id, name: 'Vous' };
}
const ME = whoAmI();

/** A short message that fades, for things that succeeded quietly. */
let statusTimer = 0;
function say(message: string, kind: 'ok' | 'error' = 'ok'): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', kind === 'error');
  statusEl.hidden = false;
  clearTimeout(statusTimer);
  // an error stays until the next message: it is the only thing telling the
  // user why nothing happened
  if (kind === 'ok') statusTimer = window.setTimeout(() => (statusEl.hidden = true), 2400);
}

/**
 * Nothing fails quietly.
 *
 * @remarks
 * Reported after the first build: "I open a folder and nothing happens." Two
 * faults, and this is the one that made the other invisible — every entry
 * point was called with `void`, so a rejected promise disappeared into the
 * console of a window with no console open. An application that cannot tell
 * you why it did nothing is worse than one that crashes.
 */
function guard<A extends unknown[]>(what: string, run: (...args: A) => Promise<unknown>) {
  return (...args: A): void => {
    void run(...args).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[carnet] ${what}`, error);
      say(`${what} : ${detail}`, 'error');
    });
  };
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[carnet] promesse rejetée', event.reason);
  say(String(event.reason instanceof Error ? event.reason.message : event.reason), 'error');
});

// --- where the vault is ------------------------------------------------------

/**
 * The last folder used, remembered next to the application's own data.
 *
 * @remarks
 * Only the *path* is remembered here. Permission to read it is remembered by
 * `persisted-scope` on the Rust side, which replays what the folder picker
 * granted — a path with no permission would reopen to an error, and a
 * permission with no path would reopen to the welcome screen.
 */
/** True when a previously used folder is still there. */
async function hasRememberedVault(): Promise<boolean> {
  const remembered = await rememberedRoot();
  return !!remembered && (await exists(remembered));
}

async function rememberedRoot(): Promise<string | null> {
  try {
    if (!(await exists(SETTINGS, { baseDir: BaseDirectory.AppConfig }))) return null;
    const settings = JSON.parse(
      await readTextFile(SETTINGS, { baseDir: BaseDirectory.AppConfig }),
    ) as { root?: string };
    return settings.root ?? null;
  } catch {
    return null;
  }
}

async function rememberRoot(path: string): Promise<void> {
  try {
    // the config directory does not exist until something writes to it
    await mkdir('', { baseDir: BaseDirectory.AppConfig, recursive: true }).catch(() => undefined);
    await writeTextFile(SETTINGS, JSON.stringify({ root: path }), { baseDir: BaseDirectory.AppConfig });
  } catch {
    // not being able to remember is a nuisance, not a failure worth stopping on
  }
}

async function pickVault(): Promise<void> {
  const chosen = await open({ directory: true, multiple: false, title: 'Choisir un dossier' });
  if (typeof chosen !== 'string') return;
  await grantAccess(chosen);
  await rememberRoot(chosen);
  await openVault(chosen);
}

/**
 * Ask the backend for access to the folder and everything under it.
 *
 * @remarks
 * The picker grants the folder itself, and only that. The canonical documents
 * live in `.nbe/` one level down, so without this every read and write there
 * is denied — which is exactly what "I open a folder and nothing happens"
 * looked like.
 */
async function grantAccess(path: string): Promise<void> {
  await invoke('allow_vault', { path });
}

async function openVault(path: string): Promise<void> {
  root = NATIVE ? path : null;
  if (NATIVE) await grantAccess(path);
  workspace = new Workspace(NATIVE ? vaultStorage(path) : scratchStorage());
  snapshots = NATIVE ? vaultSnapshots(path) : memorySnapshots();
  assets = NATIVE ? vaultAssets(path) : memoryAssets();
  await workspace.load();
  vaultLabel.textContent = path.split('/').pop() ?? path;
  welcomeEl.hidden = true;
  sidebarEl.hidden = false;

  /*
   * Databases are §2.5's four records: the schema and the view are workspace
   * records in `.nbe/collections.json`, and every row is an ordinary page —
   * which is why a row opens in the editor like anything else.
   */
  const store = NATIVE ? collectionStore(path) : scratchCollections();
  collections = await store.read();
  database = createDatabaseHost(workspace, collections, store, {
    openPage: (id) => goTo(id),
    onMutate: () => void render(),
  });

  if (!workspace.roots.length) await workspace.createPage({ title: 'Bienvenue' });
  await render();
  await openPage(workspace.roots[0]!);
}

// --- the page tree -----------------------------------------------------------

/** Open a page, reporting anything that stops it. */
const goTo = (pageId: string) => guard('Ouverture de la page', () => openPage(pageId))();

function pageButton(id: string, label: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => goTo(id));
  return button;
}

async function render(): Promise<void> {
  if (!workspace) return;
  await workspace.load();

  const row = (id: string, depth: number): HTMLElement[] => {
    const node = workspace!.node(id);
    // a row page belongs to its table, not to the tree
    if (!node || workspace!.document(id)?.props?.['collectionId']) return [];
    const button = document.createElement('button');
    button.className = `page-item${id === openId ? ' active' : ''}`;
    button.style.paddingInlineStart = `${10 + depth * 14}px`;
    button.append(
      Object.assign(document.createElement('span'), {
        className: 'page-label',
        textContent: `${node.children.length ? '📂' : '📄'} ${node.title}`,
      }),
    );

    const add = document.createElement('span');
    add.className = 'page-add';
    add.title = 'Nouvelle sous-page';
    add.textContent = '＋';
    add.addEventListener('click', async (event) => {
      event.stopPropagation();
      const created = await workspace!.createPage({ parentId: id, title: '' });
      await syncVault();
      await render();
      await openPage(created);
    });
    button.append(add);

    button.addEventListener('click', () => goTo(id));
    return [button, ...node.children.flatMap((child) => row(child, depth + 1))];
  };

  pagesEl.replaceChildren(...workspace.roots.flatMap((id) => row(id, 0)));
  renderCrumbs();
  renderBacklinks();
  renderSearch();
}

function renderCrumbs(): void {
  if (!workspace || !openId) return void (crumbsEl.textContent = '');
  const path = workspace.path(openId);
  crumbsEl.replaceChildren(
    ...path.flatMap((node, index) => {
      const parts: Node[] = index > 0 ? [document.createTextNode(' / ')] : [];
      parts.push(
        index === path.length - 1
          ? Object.assign(document.createElement('span'), { className: 'crumb current', textContent: node.title })
          : pageButton(node.id, node.title, 'crumb'),
      );
      return parts;
    }),
  );
}

const BACKLINK_LABEL: Record<string, string> = {
  sub_page: 'sous-page de',
  link_to_page: 'lien depuis',
  mention: 'mentionnée dans',
};

function renderBacklinks(): void {
  const links = workspace && openId ? workspace.backlinks(openId) : [];
  backlinksEl.hidden = links.length === 0;
  if (!links.length) return;
  backlinksEl.replaceChildren(
    Object.assign(document.createElement('h2'), {
      textContent: `${links.length} référence${links.length > 1 ? 's' : ''}`,
    }),
    ...links.map((link) => {
      const line = document.createElement('div');
      line.className = 'backlink';
      line.append(
        Object.assign(document.createElement('span'), {
          className: 'backlink-kind',
          textContent: BACKLINK_LABEL[link.kind] ?? link.kind,
        }),
        pageButton(link.pageId, link.title, 'backlink-page'),
      );
      return line;
    }),
  );
}

function renderSearch(): void {
  const query = searchEl.value.trim();
  const active = query.length > 0;
  resultsEl.hidden = !active;
  pagesEl.hidden = active;
  if (!active || !workspace) return;
  const hits = workspace.search(query);
  if (!hits.length) {
    resultsEl.replaceChildren(
      Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Aucun résultat' }),
    );
    return;
  }
  resultsEl.replaceChildren(
    ...hits.map((hit) => {
      const button = document.createElement('button');
      button.className = 'result';
      button.append(
        Object.assign(document.createElement('span'), { className: 'result-title', textContent: hit.title }),
        Object.assign(document.createElement('span'), { className: 'result-snippet', textContent: hit.snippet }),
      );
      button.addEventListener('click', () => {
        searchEl.value = '';
        renderSearch();
        goTo(hit.pageId);
      });
      return button;
    }),
  );
}

// --- the open page -----------------------------------------------------------

/**
 * Persisting on every change, debounced.
 *
 * @remarks
 * Every keystroke is a transaction, and a transaction per file write would
 * make typing wait on the disk. 400ms is long enough to coalesce a burst of
 * typing and short enough that closing the window never loses a sentence — and
 * the flush on `beforeunload` covers the rest.
 */
let saveTimer = 0;
let dirty = false;

function persistSoon(): void {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persistNow(), 400);
}

/** The CRDT document currently open, so it can be snapshotted on save. */
let liveStore: LoroBlockStore | null = null;
/** Stops syncing the open page. Replaced on every navigation. */
let stopSync: (() => void) | null = null;
/** Stops watching the open page's comments. Replaced on every navigation. */
let stopComments: (() => void) | null = null;

/**
 * Where to sync, if anywhere.
 *
 * @remarks
 * In `localStorage` rather than in the vault: it is a property of *this
 * machine*, not of the notes. Putting it in the folder would sync a server
 * address to every device that opened it, which is both surprising and the
 * beginning of a way to redirect someone else's document.
 */
const RELAY_KEY = 'carnet.relay';

const relayUrl = (): string | null => localStorage.getItem(RELAY_KEY);

/**
 * Join the room for the open page.
 *
 * @remarks
 * One room per page, named by its id — page ids are UUIDv7 and already unique,
 * and syncing a whole workspace as one document would make every peer download
 * every page to read one.
 *
 * Failure here is never fatal. The document is on disk and the editor works;
 * a relay that is down means "not syncing right now", which is exactly what
 * offline-first is supposed to survive.
 *
 * **The relay is only the way in.** `p2pTransport` uses it to negotiate a
 * WebRTC data channel with the other peers and then stops sending the document
 * through it — see `docs/research/p2p-any-sync.md`. Nothing here has to change
 * for that: the webview already has `RTCPeerConnection`, and the transport is
 * still one transport. The status line is what makes the difference visible,
 * because a silent optimisation nobody can observe is one nobody can debug.
 */
function joinRoom(pageId: string, store: LoroBlockStore): void {
  stopSync?.();
  stopSync = null;
  const url = relayUrl();
  if (!url) return void showRelayState();

  try {
    const host = new URL(url).host;
    const stop = connect(
      store,
      p2pTransport(connectToRelay(url, pageId), {
        onState: ({ peers, direct, relayed }) =>
          showRelayState(
            !peers
              ? `Synchronisé — ${host}`
              : relayed
                ? `Synchronisé via ${host} — ${peers} pair(s)`
                : `Pair-à-pair — ${direct} pair(s) en direct`,
          ),
      }),
    );
    const stopRedraw = redrawOnRemote(store.doc, () => {
      // a remote edit never passes through this editor, so nothing repaints it
      view?.renderAll();
      persistSoon();
    });
    stopSync = () => {
      stopRedraw();
      stop();
    };
    showRelayState(`Synchronisé — ${new URL(url).host}`);
  } catch (error) {
    console.error('[carnet] synchronisation impossible', error);
    showRelayState('Synchronisation indisponible');
  }
}

function showRelayState(text?: string): void {
  const node = document.getElementById('relay-state');
  if (node) node.textContent = text ?? (relayUrl() ? 'Connexion…' : 'Hors ligne');
}

async function persistNow(): Promise<void> {
  if (!dirty || !workspace || !editor || !openId) return;
  dirty = false;
  await workspace.save(openId, docToJSON(editor.doc) as BlockJSON);
  /*
   * Both, and neither derived from the other: the JSON is what survives this
   * app being deleted, and the snapshot is what carries the merge identity and
   * the history that JSON has nowhere to put. Written from the same document,
   * so they cannot disagree.
   */
  if (snapshots && liveStore) {
    await snapshots.write(openId, liveStore.doc.export({ mode: 'snapshot' })).catch((error: unknown) => {
      // history is recoverable; the page is not. Never fail a save over this.
      console.error('[carnet] instantané non écrit', error);
    });
  }
  /*
   * The Markdown mirror is a *projection*, and a projection failing must never
   * stop the thing it projects. This used to be awaited inside `persistNow`,
   * which every navigation calls first — so one unwritable file meant clicking
   * a page did nothing at all, with no way to tell.
   */
  void syncVault().catch((error: unknown) => {
    console.error('[carnet] Markdown non régénéré', error);
    say('Markdown non régénéré — les pages sont enregistrées', 'error');
  });
}

async function openPage(pageId: string): Promise<void> {
  if (!workspace) return;
  await persistNow();
  const document_ = workspace.document(pageId);
  if (!document_) return;

  openId = pageId;
  view?.destroy();

  /*
   * The page's *document*, not its content. A CRDT cannot be rebuilt from JSON
   * and still merge — two peers seeded separately from identical JSON converge
   * on every block twice, because the identity Loro tracks is the tree node it
   * created (`packages/collab/test/seeding.test.ts`). So the snapshot is the
   * thing that is opened, and the JSON is the fallback for a page that has
   * never had one.
   */
  const store = new LoroBlockStore();
  const snapshot = snapshots ? await snapshots.read(pageId) : null;
  if (snapshot) store.import(snapshot);
  else seedFromJSON(store, document_);
  editor = new Editor({ doc: { blocks: store, rootId: document_.id } });
  liveStore = store;
  joinRoom(pageId, store);

  /*
   * Comments in the page's own document, not beside it: one `LoroDoc` means
   * one connection, one snapshot, and a reply that arrives with the text it
   * annotates rather than a version behind it. Nothing extra is persisted —
   * the snapshot already written on every save carries them.
   */
  const comments = new LoroComments(store.doc);
  stopComments?.();
  // a comment never passes through the editor, so nothing else marks the page
  // dirty — and unwritten comments are the one thing the JSON cannot hold
  stopComments = comments.onChange(() => persistSoon());

  view = new EditorView(editorEl, editor, {
    labels: fr,
    features: FEATURES,
    blocks: BLOCKS,
    database: database ?? undefined,
    commentAuthor: ME,
    // the bubble is `@nbe/dom`'s, like every other host's — a fourth composer
    // written here is a fourth one to get wrong
    onComment: (blockId, author) =>
      void openCommentThread({ editor: editor!, store: comments, blockId, author, labels: fr }),
    // a pasted or dropped file becomes a file in the folder, and the document
    // keeps the path — so an image is still an image after this app is gone
    onStoreAsset: (blob) => assets!.store(blob),
    resolveAssetUrl: (src) => assets!.resolve(src),
    onOpenPage: (id) => goTo(id),
    onSearchPages: (query) => {
      const wanted = query.toLowerCase().trim();
      return (workspace?.pages ?? [])
        .filter((node) => !wanted || node.title.toLowerCase().includes(wanted))
        .slice(0, 8)
        .map((node) => ({ pageId: node.id, title: node.title || 'Sans titre' }));
    },
    resolvePageTitle: (id: string) => workspace?.node(id)?.title ?? null,
    onCreatePage: () => {
      // the editor asks synchronously; create the page and let the tree catch up
      const created = { pageId: crypto.randomUUID(), title: 'Sans titre' };
      void (async () => {
        const id = await workspace!.createPage({ parentId: openId, title: '' });
        await render();
        await openPage(id);
      })();
      return created;
    },
  });
  editor.on(() => persistSoon());
  await render();
}

// --- the Markdown a person reads --------------------------------------------

/**
 * Regenerate the Markdown vault.
 *
 * @remarks
 * Rebuilt rather than patched, for the same reason the CLI rebuilds it: a
 * renamed or moved page changes its *path*, and patching leaves the old file
 * behind as a second copy that any importer would read back as a second page.
 * Rebuilding also makes the projection provable — there is nothing in the
 * folder that the canonical JSON does not have.
 */
async function syncVault(): Promise<void> {
  if (!workspace || !root) return; // no root outside Tauri: nothing to mirror
  await workspace.load();
  const files = exportVault(workspace);
  // cleared first, so a page that vanished does not leave its Markdown behind
  await clearDirectory(`${root}/pages`);
  for (const file of files) {
    if (typeof file.text === 'string') await writeInto(root, `pages/${file.path}`, file.text);
  }
}

// --- wiring ------------------------------------------------------------------

el('pick-vault').addEventListener('click', guard('Ouverture du dossier', pickVault));
el('welcome-pick').addEventListener('click', guard('Ouverture du dossier', pickVault));
el('new-page').addEventListener('click', guard('Nouvelle page', async () => {
  if (!workspace) return;
  const id = await workspace.createPage({ title: '' });
  await syncVault();
  await render();
  await openPage(id);
}));
el('relay').addEventListener('click', () => {
  /*
   * A prompt, not a settings panel. One field with no other settings beside it
   * does not need a panel, and inventing one now would be a screen to maintain
   * before there is anything to put on it.
   */
  const current = relayUrl() ?? '';
  const next = prompt('Adresse du nœud de synchronisation (vide pour arrêter)', current);
  if (next === null) return;
  if (next.trim()) localStorage.setItem(RELAY_KEY, next.trim());
  else localStorage.removeItem(RELAY_KEY);

  // rejoin with the new address, or stop
  if (openId && liveStore) joinRoom(openId, liveStore);
  else showRelayState();
});

el('sync').addEventListener('click', guard('Régénération du Markdown', async () => {
  await persistNow();
  await syncVault();
  say('Markdown régénéré');
}));
statusEl.addEventListener('click', () => (statusEl.hidden = true));
searchEl.addEventListener('input', () => renderSearch());
searchEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  searchEl.value = '';
  renderSearch();
});

// a debounced save may not have fired yet when the window closes
window.addEventListener('beforeunload', () => void persistNow());

/*
 * A remembered folder can be gone, renamed, or on a volume that is not
 * mounted. None of those is a crash: fall back to the welcome screen and say
 * what happened, rather than opening onto an empty workspace that looks like
 * data loss.
 */
try {
  if (!NATIVE) {
    // running in a plain browser: open a scratch workspace so the interface
    // can be seen, driven and tested without building a window
    await openVault('(navigateur)');
    say('Espace de travail temporaire — aucun fichier ne sera écrit');
  } else if (await hasRememberedVault()) await openVault((await rememberedRoot())!);
  else {
    sidebarEl.hidden = true;
    welcomeEl.hidden = false;
  }
} catch (error) {
  sidebarEl.hidden = true;
  welcomeEl.hidden = false;
  say(`Dossier précédent inaccessible : ${error instanceof Error ? error.message : String(error)}`, 'error');
}
