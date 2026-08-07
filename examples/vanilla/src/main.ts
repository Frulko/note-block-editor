import { docFromJSON, docToJSON, Editor, uuidv7, type BlockJSON, type Run } from '@nbe/core';
import { EditorView, perBlockTopology, singleHostTopology } from '@nbe/dom';
import { callout } from '@nbe/blocks-callout/dom';
import '@nbe/dom/style.css';
import './demo.css';
import { attachInspector } from './inspector';
import { resolveAsset, storeAsset, releaseAssetUrls } from './assets';
import { createDatabaseHost } from './dbhost';
import { Workspace as PageTree, pageTitle } from '@nbe/workspace';
import {
  createPage,
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

const ws: Workspace = loadWorkspace(seedPage);
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
    return [btn, ...node.children.flatMap((child) => row(child, depth + 1))];
  };

  pagesEl.replaceChildren(...tree.roots.flatMap((id) => row(id, 0)));
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
document.getElementById('reset')!.addEventListener('click', () => {
  if (confirm('Réinitialiser la démo ? Toutes les pages seront perdues.')) resetWorkspace();
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

// blobs stay pinned in memory until their object URLs are released
window.addEventListener('pagehide', releaseAssetUrls);
