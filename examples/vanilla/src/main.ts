import { docFromJSON, docToJSON, Editor, uuidv7, type BlockJSON, type Run } from '@nbe/core';
import {
  EditorView,
  createExport,
  defaultFeatures,
  findFeature,
  fr,
  perBlockTopology,
  singleHostTopology,
  wordCountFeature,
} from '@nbe/dom';
import { renderToHTML } from '@nbe/static-renderer';
import { mermaidStyles } from '@nbe/blocks-mermaid';
import { mermaidFeature } from '@nbe/blocks-mermaid/dom';
import { callout } from '@nbe/blocks-callout/dom';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import { code } from '@nbe/blocks-code/dom';
import { floatingTocFeature, toc } from '@nbe/blocks-toc/dom';
import { mdx } from '@nbe/blocks-mdx/dom';
import { PluginRegistry } from '@nbe/core';
import '@nbe/dom/style.css';
import './demo.css';

// the mermaid feature ships its CSS as a string, like a block plugin's `styles`
document.head.append(Object.assign(document.createElement('style'), { textContent: mermaidStyles }));
import { attachInspector } from './inspector';
import { createComments, ME } from './comments';
import { allAssetBytes, resolveAsset, storeAsset, releaseAssetUrls, sweepAssets } from './assets';
import { Workspace as PageTree, pageTitle, referencedAssets } from '@nbe/workspace';
import { createDatabaseHost, type CollectionRecord, type CollectionStore } from '@nbe/workspace/database';
import { exportVault, importVault, slugify } from '@nbe/workspace/vault';
import { blocksToMarkdown } from '@nbe/markdown';

/** The block set this demo runs: the editor, the projections and the importers
 * all read the same registry, so nothing renders in one and vanishes in another. */
const BLOCKS = [callout, code, toc, mdx, ...tableDomBlocks];
const PLUGINS = new PluginRegistry().registerAll(BLOCKS);
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
      b('to_do', 'Survoler un bloc : + et ⋮⋮ à gauche, 💬 à droite (marges configurables)', { checked: false }),
      b('to_do', 'Commenter un bloc, puis l\'onglet Commentaires à droite', { checked: false }),
      b('to_do', 'Glisser un bloc : toute la largeur réordonne (colonnes : ?columns=on)', { checked: false }),
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

/*
 * Theme, before the await below: `data-nbe-theme` on <html> is the editor's
 * documented host hook and the demo tokens read the same attribute, so one
 * property themes both. Applied first so a saved choice never flashes.
 */
const themeEl = document.getElementById('theme') as HTMLSelectElement;
themeEl.value = localStorage.getItem('nbe-demo-theme') ?? '';
const applyTheme = (): void => {
  if (themeEl.value) document.documentElement.dataset['nbeTheme'] = themeEl.value;
  else delete document.documentElement.dataset['nbeTheme'];
  localStorage.setItem('nbe-demo-theme', themeEl.value);
};
applyTheme();
themeEl.addEventListener('change', applyTheme);

// top-level await: pages now live in IndexedDB, and the shell has nothing
// useful to show before they arrive
const ws: Workspace = await loadWorkspace(seedPage);
let editor: Editor;
let view: EditorView | null = null;
let detachInspector: (() => void) | null = null;

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
await tree.load();

/*
 * Threads are shared by every page and saved with the metadata, like the
 * collections: infrequent, deliberate, and flushed rather than debounced, so a
 * reload inside the 300ms typing window cannot drop one.
 */
const comments = createComments(ws.threads ?? [], (threads) => {
  ws.threads = threads;
  saveWorkspace(ws);
  flushWorkspace();
});

/**
 * Collection schemas and views, in the workspace metadata.
 *
 * @remarks
 * Persisted synchronously rather than on the typing debounce: a database edit
 * is infrequent and deliberate, and a reload landing inside a 300ms window
 * would drop one.
 */
const collections: CollectionStore = {
  read: async () => (ws.collections ??= []),
  write: async (records: CollectionRecord[]) => {
    ws.collections = records;
    saveWorkspace(ws);
    flushWorkspace();
  },
};

/*
 * The shared host, not a copy. The demo used to carry its own implementation
 * of §2.5 beside the one in `@nbe/workspace`; they agreed until one of them
 * learned something. This one derives rows from `props.collectionId` instead
 * of keeping a parallel `rowIds` list.
 */
const dbHost = createDatabaseHost(tree, await collections.read(), collections, {
  openPage: (id) => void openPage(id),
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
  const flags = new URLSearchParams(location.search);
  const extraFeatures = [
    ...(flags.get('find') === 'on' ? [findFeature] : []),
    ...(flags.get('count') === 'on' ? [wordCountFeature] : []),
    // ?outline=on floats the headings beside the note and follows the scroll
    ...(flags.get('outline') === 'on' ? [floatingTocFeature] : []),
    // mermaid is lazily imported by the feature: a page with no diagram on it
    // never downloads the library
    mermaidFeature,
    ...(flags.get('export') === 'on'
      ? [
          createExport([
            {
              id: 'html',
              label: 'HTML (.html)',
              // the static renderer is the demo's to depend on; `@nbe/dom` may
              // depend on core and markdown and nothing else, and CI says so
              text: (v) => renderToHTML(docToJSON(v.editor.doc), { plugins: PLUGINS }),
            },
          ]),
        ]
      : []),
  ];
  view = new EditorView(editorEl, editor, {
    // ?topology=single-host to exercise the alternative editable boundary
    topology:
      new URLSearchParams(location.search).get('topology') === 'single-host'
        ? singleHostTopology
        : perBlockTopology,
    // ?columns=on to exercise the experimental side-drop that builds columns
    columns: new URLSearchParams(location.search).get('columns') === 'on',
    /*
     * ?find=on for the in-page search. Off by default here on purpose: in a
     * browser `⌘F` is the browser's, and a web page that takes it away to
     * offer something worse is exactly what this project set out not to be.
     * The hosts with no browser find of their own — the Obsidian pane, the
     * desktop shell — turn it on.
     */
    /*
     * ?export=on adds ⌘P — Markdown, texte, HTML and print-to-PDF. Off here
     * for the same reason as the find bar: ⌘P is the browser's print dialog,
     * and a page that takes it had better be offering more than a worse one.
     */
    features: extraFeatures.length ? [...defaultFeatures, ...extraFeatures] : undefined,
    // activation is an import plus an array entry
    // the editor's default is English now; Carnet is French and says so
    labels: fr,
    blocks: BLOCKS,
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
    // comments are on blocks: the affordance is the right-hand gutter
    onComment: (blockId, author) => comments.comment(editor!, blockId, author),
    commentAuthor: ME,
  });
  detachInspector = attachInspector(editor);
  comments.render(editor);
  editor.on(() => {
    persistCurrentPage();
    void renderSidebar();
    comments.render(editor);
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
  download(zip(exportVault(tree, { assets, plugins: PLUGINS })), 'workspace-markdown.zip');
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
    const imported = fromNotion
      ? importNotion(files, { plugins: PLUGINS })
      : { pages: importVault(files, { plugins: PLUGINS }), collections: [] };
    const pages = imported.pages;
    // a database arrives as §2.5's four records: its schema and view are host
    // records the database host owns, its rows are pages like any other
    for (const collection of imported.collections) {
      // no row list: a page belongs to a collection because its own props say
      // so, which is the only place that fact is written
      (ws.collections ??= []).push({ schema: collection.schema, view: collection.view });
    }
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
/*
 * The panels are drawers below 900px. The editor is the application on a
 * narrow screen; the sidebar navigates and the inspector explains, and both
 * can wait behind a button rather than taking two thirds of a phone.
 */
const scrim = document.getElementById('scrim')!;
const drawers: Array<[button: HTMLElement, panel: HTMLElement]> = [
  [document.getElementById('toggle-pages')!, document.getElementById('sidebar')!],
  [document.getElementById('toggle-inspector')!, document.getElementById('inspector')!],
];

function setDrawer(panel: HTMLElement | null): void {
  for (const [button, candidate] of drawers) {
    const open = candidate === panel;
    candidate.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  }
  scrim.hidden = panel === null;
}

for (const [button, panel] of drawers) {
  button.addEventListener('click', () => setDrawer(panel.classList.contains('open') ? null : panel));
}
scrim.addEventListener('click', () => setDrawer(null));
// opening a page from the sidebar is the end of using it
document.getElementById('sidebar')!.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.page-item, .result')) setDrawer(null);
});

/*
 * The open page leaves on its own: the JSON is the document itself, the
 * Markdown is its L1 projection — the same two views the inspector shows.
 */
function exportPage(extension: 'json' | 'md'): void {
  const json = docToJSON(editor.doc);
  const body =
    extension === 'json' ? JSON.stringify(json, null, 2) : blocksToMarkdown(json.children ?? [], { plugins: PLUGINS });
  const type = extension === 'json' ? 'application/json' : 'text/markdown';
  download(new Blob([body], { type }), `${slugify(pageTitle(json) || 'page')}.${extension}`);
}
document.getElementById('export-json')!.addEventListener('click', () => exportPage('json'));
document.getElementById('export-md')!.addEventListener('click', () => exportPage('md'));

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
