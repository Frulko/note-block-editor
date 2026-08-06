import { docFromJSON, Editor, uuidv7, type BlockJSON, type Run } from '@nbe/core';
import { EditorView } from '@nbe/dom';
import '@nbe/dom/style.css';
import './demo.css';
import { attachInspector } from './inspector';

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

const page: BlockJSON = {
  id: uuidv7(),
  type: 'page',
  version: 1,
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
    b('to_do', 'Taper du texte, puis Cmd+Z pour annuler', { checked: true }),
    b('to_do', 'Écrire "# " ou "- " ou "[] " en début de bloc (autoformat markdown)', { checked: false }),
    b('to_do', 'Sélectionner du texte : Cmd+B, Cmd+I, Cmd+E', { checked: false }),
    b('to_do', 'Tab / Shift+Tab pour imbriquer les blocs', { checked: false }),
    b('toggle', 'Un toggle avec des enfants', { collapsed: false }, [
      b('paragraph', 'Le contenu imbriqué vit dans le champ children du bloc parent.'),
      b('bulleted_list_item', 'Enter continue la liste'),
      b('bulleted_list_item', 'Enter sur un item vide le transforme en paragraphe'),
    ]),
    b('quote', 'Le DOM est une projection jetable du modèle — jamais la source de vérité.'),
    b('code', "const doc = 'lisible sans l'outil';", { language: 'ts' }),
    b('divider', ''),
    b('paragraph', ''),
  ],
};

const editor = new Editor({ doc: docFromJSON(page) });
new EditorView(document.getElementById('editor')!, editor);
attachInspector(editor);

document.getElementById('undo')!.addEventListener('click', () => editor.undo());
document.getElementById('redo')!.addEventListener('click', () => editor.redo());

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button, .panel').forEach((n) => n.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset['tab']}`)!.classList.add('active');
  });
}
