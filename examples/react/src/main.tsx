import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockEditor, type BlockJSON } from '@nbe/react';
import { renderToHTML } from '@nbe/static-renderer';
import { uuidv7 } from '@nbe/core';
import '@nbe/dom/style.css';
import './demo.css';

const initialContent: BlockJSON = {
  id: uuidv7(),
  type: 'page',
  version: 1,
  children: [
    { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: [{ text: 'Éditeur dans React' }] },
    {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      text: [
        { text: 'Le binding est une ' },
        { text: 'monture fine', marks: [{ type: 'bold' }] },
        { text: ' : lifecycle, projection, hébergement de la vue DOM. Toute la logique reste dans ' },
        { text: '@nbe/core', marks: [{ type: 'code' }] },
        { text: ' et ' },
        { text: '@nbe/dom', marks: [{ type: 'code' }] },
        { text: '.' },
      ],
    },
    { id: uuidv7(), type: 'to_do', version: 1, props: { checked: false }, text: [{ text: 'Taper "/" pour le menu' }] },
    { id: uuidv7(), type: 'callout', version: 1, props: { icon: '⚛️' }, text: [{ text: "Le panneau de droite est le rendu statique (@nbe/static-renderer) : le même document, sans instance d'éditeur — c'est ce qui part en SSR." }] },
    { id: uuidv7(), type: 'paragraph', version: 1, text: [] },
  ],
};

function App() {
  const [doc, setDoc] = useState<BlockJSON>(initialContent);
  const [tab, setTab] = useState<'html' | 'json'>('html');

  return (
    <div className="app">
      <header>
        <strong>notion-block-editor</strong> <span className="tag">React</span>
      </header>
      <main>
        <div className="pane editor-pane">
          <BlockEditor className="page" initialContent={initialContent} onChange={setDoc} />
        </div>
        <aside className="pane inspector">
          <nav>
            <button className={tab === 'html' ? 'active' : ''} onClick={() => setTab('html')}>
              Rendu statique
            </button>
            <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
              Document
            </button>
          </nav>
          {tab === 'html' ? (
            <div className="static-preview" dangerouslySetInnerHTML={{ __html: renderToHTML(doc) }} />
          ) : (
            <pre>{JSON.stringify(doc, null, 2)}</pre>
          )}
        </aside>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
