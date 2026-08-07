import { docFromJSON, docToJSON, Editor, uuidv7, type BlockJSON, type Run } from '@nbe/core';
import { EditorView, perBlockTopology, singleHostTopology } from '@nbe/dom';
import { callout } from '@nbe/blocks-callout/dom';
import '@nbe/dom/style.css';
import './demo.css';
import { attachInspector } from './inspector';
import { allAssetBytes, resolveAsset, storeAsset, releaseAssetUrls, sweepAssets } from './assets';
import { createDatabaseHost } from './dbhost';
import { Workspace as PageTree, pageTitle, referencedAssets } from '@nbe/workspace';
import { exportVault, importVault } from '@nbe/workspace/vault';
import { importNotion } from '@nbe/workspace/notion';
import { download, unzip, zip } from './zip';
import {
  createPage,
  flushWorkspace,
  loadWorkspace,
  pageStorage,
  resetWorkspace,
  saveWorkspace,
  type Workspace,
} from './workspace';

function b(type: string, text: string | Run[], props?: Record<string, unknown>, children?: BlockJSON[]): BlockJSON {
  return {
    id: uuidv7(),
    type,
    version: 1,
    ...(props ? { props } : {}),
    text: typeof text === 'string' ? (text ? [{ text }] : []) : text,
    ...(children?.length ? { children } : {}),
  };
}

function seedPage(): BlockJSON {
  return {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: { title: "L'éditeur de blocs" },
    children: [
      b('heading', "L'éditeur de blocs", { level: 1 }),
      b('paragraph', [
        { text: 'Un éditeur à la Notion en ' },
        { text: 'vanilla TypeScript', marks: [{ type: 'bold' }] },
        { text: ' : le document est un ' },
        { text: 'schéma intermédiaire', marks: [{ type: 'italic' }] },
        { text: ' — regarde le panneau ' },
        { text: 'Document', marks: [{ type: 'code' }] },
        { text: ' se mettre à jour pendant que tu tapes.' },
      ]),
      b('heading', 'Essaie', { level: 2 }),
      b('to_do', 'Taper "/" pour le menu de blocs', { checked: false }),
      b('to_do', 'Survoler un bloc : + et ⋮⋮ (menu, drag & drop)', { checked: false }),
      b('to_do', 'Glisser un bloc sur le bord droit d\'un autre → colonnes', { checked: false }),
      b('to_do', 'Escape pour sélectionner le bloc, flèches, Backspace', { checked: false }),
      b('to_do', 'Copier/coller depuis Google Docs ou du markdown', { checked: false }),
      b('toggle', 'Un toggle avec des enfants', { collapsed: false }, [
        b('paragraph', 'Le contenu imbriqué vit dans le champ children du bloc parent.'),
        b('bulleted_list_item', 'Enter continue la liste'),
        b('bulleted_list_item', 'Tab / Shift+Tab pour imbriquer'),
      ]),
      b('quote', 'Le DOM est une projection jetable du modèle — jamais la source de vérité.'),
      b('callout', 'Tout passe par 7 opérations invertibles — le panneau Transactions montre le flux.', { icon: '⚙️' }),
      b('code', "const doc = 'lisible sans l'outil';", { language: 'ts' }),
      b('divider', ''),
      b('paragraph', ''),
    ],
  };
}

// top-level await: pages now live in IndexedDB, and the shell has nothing
// useful to show before they arrive
const ws: Workspace = await loadWorkspace(seedPage);
let editor: Editor;
let view: EditorView | null = null;
let detachInspector: (() => void) | null = null;
const dbHost = createDatabaseHost(ws, {
  openPage: (id) => openPage(id),
  onMutate: () => void renderSidebar(),
});

const editorEl = document.getElementById('editor')!;
const pagesEl = document.getElementById('pages')!;

function persistCurrentPage(): void {
  const json = docToJSON(editor.doc);
  const idx = ws.pages.findIndex((p) => p.id === json.id);
  if (idx >= 0) ws.pages[idx] = json;
  saveWorkspace(ws);
}

/**
 * The page tree, derived from the documents on every render.
 *
 * @remarks
 * Phase 4's model: nothing about the tree is stored — it is computed from the
 * `sub_page` blocks inside each page. Rebuilding it per render is a scan of a
 * handful of documents, and it means the sidebar cannot disagree with what is
 * actually written in the pages, which a cached tree eventually does.
 */
const tree = new PageTree(pageStorage(ws));

const searchEl = document.getElementById('search') as HTMLInputElement;
const resultsEl = document.getElementById('results')!;
const crumbsEl = document.getElementById('crumbs')!;
const backlinksEl = document.getElementById('backlinks')!;

/** A button that opens a page, used by the breadcrumb, results and backlinks. */
function pageButton(pageId: string, label: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', () => openPage(pageId));
  return btn;
}

/** The path from a root down to the open page — where am I. */
function renderCrumbs(): void {
  const path = tree.path(ws.openId);
  crumbsEl.replaceChildren(
    ...path.flatMap((node, i) => {
      const parts: Node[] = [];
      if (i > 0) parts.push(document.createTextNode(' / '));
      parts.push(
        i === path.length - 1
          ? Object.assign(document.createElement('span'), { className: 'crumb current', textContent: node.title })
          : pageButton(node.id, node.title, 'crumb'),
      );
      return parts;
    }),
  );
}

/**
 * Pages that point at this one.
 *
 * @remarks
 * Derived, never authored (§2.4) — and the *kind* is shown because the three
 * mean different things: a sub-page is where the page lives, a link and a
 * mention are where it is talked about.
 */
const BACKLINK_LABEL: Record<string, string> = {
  sub_page: 'sous-page de',
  link_to_page: 'lien depuis',
  mention: 'mentionnée dans',
};

function renderBacklinks(): void {
  const links = tree.backlinks(ws.openId);
  backlinksEl.hidden = links.length === 0;
  if (!links.length) return;
  const title = document.createElement('h2');
  title.textContent = `${links.length} référence${links.length > 1 ? 's' : ''}`;
  backlinksEl.replaceChildren(
    title,
    ...links.map((link) => {
      const row = document.createElement('div');
      row.className = 'backlink';
      const kind = document.createElement('span');
      kind.className = 'backlink-kind';
      kind.textContent = BACKLINK_LABEL[link.kind] ?? link.kind;
      row.append(kind, pageButton(link.pageId, link.title, 'backlink-page'));
      return row;
    }),
  );
}

/** Full-text search across the workspace, replacing the tree while it is live. */
function renderSearch(): void {
  const query = searchEl.value.trim();
  const active = query.length > 0;
  resultsEl.hidden = !active;
  pagesEl.hidden = active;
  if (!active) return;
  const hits = tree.search(query);
  if (!hits.length) {
    resultsEl.replaceChildren(
      Object.assign(document.createElement('p'), { className: 'no-results', textContent: 'Aucun résultat' }),
    );
    return;
  }
  resultsEl.replaceChildren(
    ...hits.map((hit) => {
      const row = document.createElement('button');
      row.className = 'result';
      const title = document.createElement('span');
      title.className = 'result-title';
      title.textContent = hit.title;
      const snippet = document.createElement('span');
      snippet.className = 'result-snippet';
      snippet.textContent = hit.snippet;
      row.append(title, snippet);
      row.addEventListener('click', () => {
        searchEl.value = '';
        renderSearch();
        openPage(hit.pageId);
      });
      return row;
    }),
  );
}

/**
 * Dragging a page in the sidebar re-parents it.
 *
 * @remarks
 * One gesture with one meaning: drop **on** a row and the page becomes its
 * child; drop on the sidebar's own background and it becomes a root. No
 * before/after bands — a tree row is 26px tall, and splitting that into three
 * zones is how a sidebar drag becomes a coin toss. Reordering siblings is the
 * block gutter's job, inside the parent page, where the `sub_page` blocks
 * actually live.
 *
 * `movePage` refuses a move into the page's own subtree, so the impossible
 * drop is rejected by the model rather than guarded here.
 */
function startPageDrag(event: PointerEvent, pageId: string): void {
  if (event.button !== 0 || (event.target as HTMLElement).classList.contains('page-add')) return;
  const origin = { x: event.clientX, y: event.clientY };
  let dragging = false;
  let target: HTMLElement | null = null;

  const clearTarget = () => {
    target?.classList.remove('page-drop');
    target = null;
  };

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 5) return;
      dragging = true;
      document.body.classList.add('page-dragging');
    }
    clearTarget();
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = under?.closest?.('.page-item') as HTMLElement | null;
    if (row && row.dataset['pageId'] !== pageId) {
      target = row;
      row.classList.add('page-drop');
    }
  };

  const up = async (e: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('page-dragging');
    const dropOn = target?.dataset['pageId'] ?? null;
    clearTarget();
    if (!dragging) return;
    // outside every row but inside the sidebar: promote to a root
    const inSidebar = (e.target as HTMLElement)?.closest?.('.sidebar');
    if (!dropOn && !inSidebar) return;
    if (await tree.movePage(pageId, dropOn)) {
      saveWorkspace(ws);
      void renderSidebar();
    }
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

searchEl.addEventListener('input', () => renderSearch());
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  searchEl.value = '';
  renderSearch();
});

async function renderSidebar(): Promise<void> {
  await tree.load();
  // database row pages live inside their collection's table, not the sidebar
  const listed = (id: string) => !ws.pages.find((p) => p.id === id)?.props?.['collectionId'];

  const row = (pageId: string, depth: number): HTMLElement[] => {
    const node = tree.node(pageId);
    if (!node || !listed(pageId)) return [];
    const btn = document.createElement('button');
    btn.className = 'page-item' + (pageId === ws.openId ? ' active' : '');
    btn.style.paddingInlineStart = `${8 + depth * 14}px`;

    const label = document.createElement('span');
    label.className = 'page-item-label';
    label.textContent = `${node.children.some(listed) ? '📂' : '📄'} ${node.title}`;
    btn.append(label);

    const links = tree.backlinks(pageId).filter((b) => b.kind !== 'sub_page');
    if (links.length) {
      const badge = document.createElement('span');
      badge.className = 'page-badge';
      badge.title = `${links.length} lien(s) vers cette page`;
      badge.textContent = `↩ ${links.length}`;
      btn.append(badge);
    }

    const add = document.createElement('span');
    add.className = 'page-add';
    add.title = 'Nouvelle sous-page';
    add.textContent = '+';
    add.addEventListener('click', async (e) => {
      e.stopPropagation();
      /*
       * A sub-page is a *block* (§2.4), so when its parent is the page being
       * edited it has to be created by a transaction — the editor owns that
       * document, and writing underneath it just gets overwritten by the next
       * persist. Closed parents have no such owner, so the workspace writes
       * them directly. Same result, two writers, never at once.
       */
      const created = await tree.createPage({ title: '' });
      if (pageId === ws.openId) {
        editor.dispatch((tx) =>
          tx.op({
            type: 'insert_block',
            block: {
              id: uuidv7(),
              type: 'sub_page',
              version: 1,
              props: { pageId: created, title: '' },
              children: [],
              parentId: editor.doc.rootId,
            },
            index: editor.doc.blocks.get(editor.doc.rootId)!.children.length,
          }),
        );
      } else {
        await tree.movePage(created, pageId);
      }
      saveWorkspace(ws);
      openPage(created);
    });
    btn.append(add);

    btn.addEventListener('click', () => openPage(pageId));
    btn.dataset['pageId'] = pageId;
    btn.addEventListener('pointerdown', (e) => startPageDrag(e, pageId));
    return [btn, ...node.children.flatMap((child) => row(child, depth + 1))];
  };

  pagesEl.replaceChildren(...tree.roots.flatMap((id) => row(id, 0)));
  renderCrumbs();
  renderBacklinks();
  renderSearch();
}

function openPage(pageId: string): void {
  if (view && editor) persistCurrentPage();
  const page = ws.pages.find((p) => p.id === pageId) ?? ws.pages[0]!;
  ws.openId = page.id;
  saveWorkspace(ws);

  view?.destroy();
  detachInspector?.();
  editor = new Editor({ doc: docFromJSON(page) });
  view = new EditorView(editorEl, editor, {
    // ?topology=single-host to exercise the alternative editable boundary
    topology:
      new URLSearchParams(location.search).get('topology') === 'single-host'
        ? singleHostTopology
        : perBlockTopology,
    // ?columns=off to exercise the reorder-only drag
    columns: new URLSearchParams(location.search).get('columns') !== 'off',
    // activation is an import plus an array entry
    blocks: [callout],
    onOpenPage: (id) => openPage(id),
    // @ mentions: the workspace is the page store, so it answers both hooks
    onSearchPages: (query) => {
      const q = query.toLowerCase().trim();
      return ws.pages
        .filter((p) => !p.props?.['collectionId'])
        .map((p) => ({ pageId: p.id, title: pageTitle(p) || 'Sans titre' }))
        .filter((c) => !q || c.title.toLowerCase().includes(q))
        .slice(0, 8);
    },
    resolvePageTitle: (id) => {
      const page = ws.pages.find((p) => p.id === id);
      return page ? pageTitle(page) || 'Sans titre' : null;
    },
    onCreatePage: () => {
      const created = createPage(ws, '');
      saveWorkspace(ws);
      void renderSidebar();
      return { pageId: created.id, title: 'Sans titre' };
    },
    onStoreAsset: storeAsset,
    resolveAssetUrl: resolveAsset,
    database: dbHost,
  });
  detachInspector = attachInspector(editor);
  editor.on(() => {
    persistCurrentPage();
    void renderSidebar();
  });
  void renderSidebar();

  // per-block anchors: #<blockId> scrolls to and flashes the block
  if (location.hash.length > 1) {
    const target = editorEl.querySelector(`[data-block-id="${CSS.escape(location.hash.slice(1))}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('nbe-flash');
      setTimeout(() => target.classList.remove('nbe-flash'), 1600);
    }
    history.replaceState(null, '', location.pathname);
  }
}

document.getElementById('new-page')!.addEventListener('click', () => {
  const page = createPage(ws, '');
  saveWorkspace(ws);
  openPage(page.id);
});
/*
 * "Delete the app, read the files" (§10) as something a visitor can actually
 * do: the workspace leaves as a folder of Markdown that opens as an Obsidian
 * vault. A zip rather than the File System Access API, which is Chromium-only
 * — the artifact is the deliverable, writing it to a directory is phase 4b.
 */
document.getElementById('export-vault')!.addEventListener('click', async () => {
  await tree.load();
  // the images travel too, or the vault has dangling references — which is
  // the one thing "readable without the tool" cannot afford
  const assets = await allAssetBytes(referencedAssets(ws.pages));
  download(zip(exportVault(tree, { assets })), 'workspace-markdown.zip');
});
/**
 * Import an archive: one of ours, or a Notion export.
 *
 * @remarks
 * Which one is decided by looking rather than by asking. A Notion export names
 * every file `Title <32 hex>.md`; ours does not. Making the user classify
 * their own zip would be asking them to know something the file already says.
 *
 * Imported pages are added, never merged over what is there: ids are
 * preserved, so re-importing the same export updates those pages and leaves
 * the rest of the workspace alone.
 */
const NOTION_NAMING = /[\s-][0-9a-f]{32}\.(md|csv)$/i;

document.getElementById('import-vault')!.addEventListener('click', () => {
  (document.getElementById('import-file') as HTMLInputElement).click();
});
document.getElementById('import-file')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const archive = input.files?.[0];
  input.value = ''; // so choosing the same file twice fires again
  if (!archive) return;
  try {
    const files = await unzip(await archive.arrayBuffer());
    // put the binaries back first, so the pages that refer to them resolve
    for (const file of files) {
      if (file.bytes) await storeAsset(new Blob([file.bytes as unknown as BlobPart]));
    }
    const fromNotion = files.some((f) => NOTION_NAMING.test(f.path));
    const pages = fromNotion ? importNotion(files) : importVault(files);
    if (!pages.length) {
      alert('Aucune page trouvée dans cette archive.');
      return;
    }
    for (const page of pages) {
      const at = ws.pages.findIndex((p) => p.id === page.id);
      if (at >= 0) ws.pages[at] = page;
      else ws.pages.push(page);
    }
    saveWorkspace(ws);
    flushWorkspace();
    await renderSidebar();
    openPage(pages[0]!.id);
  } catch (err) {
    console.error('[demo] import failed', err);
    alert("Impossible de lire cette archive.");
  }
});

document.getElementById('reset')!.addEventListener('click', () => {
  if (confirm('Réinitialiser la démo ? Toutes les pages seront perdues.')) void resetWorkspace();
});
document.getElementById('undo')!.addEventListener('click', () => editor.undo());
document.getElementById('redo')!.addEventListener('click', () => editor.redo());

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button, .panel').forEach((n) => n.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset['tab']}`)!.classList.add('active');
  });
}

openPage(ws.openId);

/*
 * Collect orphaned blobs, once, now (AQ#2). At load this tab has no undo
 * history, so an unreferenced asset is unreachable rather than merely unused —
 * which is what makes deleting it safe without reference counts. Guarded on a
 * non-empty workspace: a failed load must never look like "nothing is used".
 */
if (ws.pages.length) {
  void sweepAssets(referencedAssets(ws.pages)).then((freed) => {
    if (freed) console.info(`[demo] ${freed} fichier(s) orphelin(s) supprimé(s)`);
  });
}

// blobs stay pinned in memory until their object URLs are released
window.addEventListener('pagehide', releaseAssetUrls);
