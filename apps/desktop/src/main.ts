import { open } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { docFromJSON, docToJSON, Editor, type BlockJSON } from '@nbe/core';
import { EditorView } from '@nbe/dom';
import { callout } from '@nbe/blocks-callout/dom';
import { Workspace, pageTitle } from '@nbe/workspace';
import { exportVault } from '@nbe/workspace/vault';
import '@nbe/dom/style.css';
import './app.css';
import { createDatabaseHost, type CollectionRecord } from '@nbe/workspace/database';
import { clearDirectory, collectionStore, vaultStorage, writeInto } from './storage';

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
let editor: Editor | null = null;
let view: EditorView | null = null;
let openId: string | null = null;
let database: ReturnType<typeof createDatabaseHost> | null = null;
let collections: CollectionRecord[] = [];

/** A short message that fades, for things that succeeded quietly. */
let statusTimer = 0;
function say(message: string): void {
  statusEl.textContent = message;
  statusEl.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => (statusEl.hidden = true), 2400);
}

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
  await rememberRoot(chosen);
  await openVault(chosen);
}

async function openVault(path: string): Promise<void> {
  root = path;
  workspace = new Workspace(vaultStorage(path));
  await workspace.load();
  vaultLabel.textContent = path.split('/').pop() ?? path;
  welcomeEl.hidden = true;
  sidebarEl.hidden = false;

  /*
   * Databases are §2.5's four records: the schema and the view are workspace
   * records in `.nbe/collections.json`, and every row is an ordinary page —
   * which is why a row opens in the editor like anything else.
   */
  const store = collectionStore(path);
  collections = await store.read();
  database = createDatabaseHost(workspace, collections, store, {
    openPage: (id) => void openPage(id),
    onMutate: () => void render(),
  });

  if (!workspace.roots.length) await workspace.createPage({ title: 'Bienvenue' });
  await render();
  await openPage(workspace.roots[0]!);
}

// --- the page tree -----------------------------------------------------------

function pageButton(id: string, label: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => void openPage(id));
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

    button.addEventListener('click', () => void openPage(id));
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
        void openPage(hit.pageId);
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

async function persistNow(): Promise<void> {
  if (!dirty || !workspace || !editor || !openId) return;
  dirty = false;
  await workspace.save(openId, docToJSON(editor.doc) as BlockJSON);
  await syncVault();
}

async function openPage(pageId: string): Promise<void> {
  if (!workspace) return;
  await persistNow();
  const document_ = workspace.document(pageId);
  if (!document_) return;

  openId = pageId;
  view?.destroy();
  editor = new Editor({ doc: docFromJSON(document_) });
  view = new EditorView(editorEl, editor, {
    blocks: [callout],
    database: database ?? undefined,
    onOpenPage: (id) => void openPage(id),
    onSearchPages: (query) => {
      const wanted = query.toLowerCase().trim();
      return (workspace?.pages ?? [])
        .filter((node) => !wanted || node.title.toLowerCase().includes(wanted))
        .slice(0, 8)
        .map((node) => ({ pageId: node.id, title: node.title || 'Sans titre' }));
    },
    onResolvePageTitle: (id) => workspace?.node(id)?.title ?? null,
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
  if (!workspace || !root) return;
  await workspace.load();
  const files = exportVault(workspace);
  // cleared first, so a page that vanished does not leave its Markdown behind
  await clearDirectory(`${root}/pages`);
  for (const file of files) {
    if (typeof file.text === 'string') await writeInto(root, `pages/${file.path}`, file.text);
  }
}

// --- wiring ------------------------------------------------------------------

el('pick-vault').addEventListener('click', () => void pickVault());
el('welcome-pick').addEventListener('click', () => void pickVault());
el('new-page').addEventListener('click', async () => {
  if (!workspace) return;
  const id = await workspace.createPage({ title: '' });
  await syncVault();
  await render();
  await openPage(id);
});
el('sync').addEventListener('click', async () => {
  await persistNow();
  await syncVault();
  say('Markdown régénéré');
});
searchEl.addEventListener('input', () => renderSearch());
searchEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  searchEl.value = '';
  renderSearch();
});

// a debounced save may not have fired yet when the window closes
window.addEventListener('beforeunload', () => void persistNow());

const remembered = await rememberedRoot();
if (remembered && (await exists(remembered))) await openVault(remembered);
else {
  sidebarEl.hidden = true;
  welcomeEl.hidden = false;
}
