import { docFromJSON, docToJSON, Editor, uuidv7, type BlockJSON, type Run } from '@nbe/core';
import { EditorView } from '@nbe/dom';
import '@nbe/dom/style.css';
import './demo.css';
import { attachInspector } from './inspector';
import { resolveAsset, storeAsset } from './assets';
import {
  backlinkCounts,
  createPage,
  loadWorkspace,
  pageTitle,
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

const editorEl = document.getElementById('editor')!;
const pagesEl = document.getElementById('pages')!;

function persistCurrentPage(): void {
  const json = docToJSON(editor.doc);
  const idx = ws.pages.findIndex((p) => p.id === json.id);
  if (idx >= 0) ws.pages[idx] = json;
  saveWorkspace(ws);
}

function renderSidebar(): void {
  const backlinks = backlinkCounts(ws);
  pagesEl.replaceChildren(
    ...ws.pages.map((page) => {
      const btn = document.createElement('button');
      btn.className = 'page-item' + (page.id === ws.openId ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'page-item-label';
      label.textContent = `📄 ${pageTitle(page)}`;
      btn.append(label);
      const count = backlinks.get(page.id);
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'page-badge';
        badge.title = `${count} lien(s) vers cette page`;
        badge.textContent = `↩ ${count}`;
        btn.append(badge);
      }
      btn.addEventListener('click', () => openPage(page.id));
      return btn;
    }),
  );
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
    onOpenPage: (id) => openPage(id),
    onCreatePage: () => {
      const created = createPage(ws, '');
      saveWorkspace(ws);
      renderSidebar();
      return { pageId: created.id, title: 'Sans titre' };
    },
    onStoreAsset: storeAsset,
    resolveAssetUrl: resolveAsset,
  });
  detachInspector = attachInspector(editor);
  editor.on(() => {
    persistCurrentPage();
    renderSidebar();
  });
  renderSidebar();

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
