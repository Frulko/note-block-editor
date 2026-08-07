import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useEditor, type Editor, type BlockJSON } from '@nbe/react';
import { docToJSON } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';

/**
 * The demo-page playground: the editor plus a debug bar — load a markdown
 * file (drag & drop or file picker), undo/redo, and inspect the live
 * document as JSON or markdown.
 */

const seed: BlockJSON = {
  id: 'pg-root',
  type: 'page',
  version: 1,
  children: [
    { id: 'pg-1', type: 'heading', version: 1, props: { level: 3 }, text: [{ text: 'Bac à sable' }] },
    { id: 'pg-2', type: 'paragraph', version: 1, text: [{ text: 'Tapez ' }, { text: '/', marks: [{ type: 'code' }] }, { text: ' pour le menu de blocs, ou déposez un fichier .md ici.' }] },
  ],
};

/** The mounted editor; remounted (new `key`) whenever a document is loaded. */
function Pane({ initial, onReady }: { initial: BlockJSON; onReady: (e: Editor) => void }) {
  const { ref } = useEditor({ initialContent: initial, onReady, maxWidth: '100%', padding: { top: '16px', bottom: '24px', x: '18px' } });
  return <div ref={ref} />;
}

export default function PlaygroundDemo() {
  const editor = useRef<Editor | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const [doc, setDoc] = useState<BlockJSON>(seed);
  const [gen, setGen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'json' | 'md'; text: string } | null>(null);

  const mount = (next: BlockJSON) => {
    setDoc(next);
    setGen((g) => g + 1);
    setPanel(null);
  };
  const readFile = (f: File | undefined | null) => {
    if (f) void f.text().then((text) => mount({ id: 'md-root', type: 'page', version: 1, children: markdownToBlocks(text) }));
  };
  const show = (kind: 'json' | 'md') => {
    const e = editor.current;
    if (!e) return;
    if (panel?.kind === kind) return setPanel(null);
    const json = docToJSON(e.doc);
    setPanel({ kind, text: kind === 'json' ? JSON.stringify(json, null, 2) : blocksToMarkdown(json.children ?? []) });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    readFile(e.dataTransfer.files[0]);
  };
  const onDragLeave = (e: DragEvent) => {
    // dragleave also fires when entering a child; only the real exit counts
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
  };

  return (
    <div style={{ position: 'relative' }} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="demo-bar">
        <span>éditeur</span>
        <span className="demo-bar-actions">
          <button onClick={() => file.current?.click()}>Charger un .md</button>
          <button onClick={() => editor.current?.undo()}>Annuler</button>
          <button onClick={() => editor.current?.redo()}>Rétablir</button>
          <button onClick={() => show('json')} aria-pressed={panel?.kind === 'json'}>JSON</button>
          <button onClick={() => show('md')} aria-pressed={panel?.kind === 'md'}>Markdown</button>
          <button onClick={() => mount(seed)}>Réinitialiser</button>
        </span>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <div className="demo-body" style={{ maxHeight: '70vh' }}>
        <Pane key={gen} initial={doc} onReady={(e) => { editor.current = e; }} />
      </div>
      {panel && <pre className="debug-panel">{panel.text}</pre>}
      {dragging && <div className="drop-overlay">Déposez votre fichier .md</div>}
    </div>
  );
}
