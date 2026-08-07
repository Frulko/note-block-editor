import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useEditor, type Editor, type BlockJSON } from '@nbe/react';
import { docToJSON } from '@nbe/core';
import { defaultFeatures, perBlockTopology, singleHostTopology } from '@nbe/dom';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';

/**
 * The demo-page playground: the editor plus a debug bar — load a markdown
 * file (drag & drop or file picker), undo/redo, inspect the live document as
 * JSON or markdown, and a dat.gui-style settings panel driving the real
 * EditorView options (geometry, read-only, topology, feature set).
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

interface Settings {
  fullWidth: boolean;
  maxWidth: number;
  padX: number;
  readOnly: boolean;
  topology: 'per-block' | 'single-host';
  off: string[]; // disabled feature names
}

const initialSettings: Settings = { fullWidth: true, maxWidth: 708, padX: 18, readOnly: false, topology: 'per-block', off: [] };

/** The chrome worth toggling; the plumbing (input, keymap, …) stays on. */
const TOGGLABLE = [
  { name: 'slash-menu', label: 'menu /' },
  { name: 'mentions', label: 'mentions @' },
  { name: 'gutter', label: 'poignée + ⋮⋮' },
  { name: 'format-toolbar', label: 'barre de formatage' },
  { name: 'block-toolbar', label: 'barre de bloc' },
  { name: 'link-hover', label: 'survol des liens' },
];

/** The mounted editor; remounted (new `key`) whenever doc or settings change. */
function Pane({ initial, settings, onReady }: { initial: BlockJSON; settings: Settings; onReady: (e: Editor) => void }) {
  const { ref } = useEditor({
    initialContent: initial,
    onReady,
    maxWidth: settings.fullWidth ? '100%' : `${settings.maxWidth}px`,
    padding: { top: '16px', bottom: '24px', x: `${settings.padX}px` },
    readOnly: settings.readOnly,
    topology: settings.topology === 'single-host' ? singleHostTopology : perBlockTopology,
    features: defaultFeatures.filter((f) => !settings.off.includes(f.name)),
  });
  return <div ref={ref} />;
}

export default function PlaygroundDemo() {
  const editor = useRef<Editor | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const [doc, setDoc] = useState<BlockJSON>(seed);
  const [gen, setGen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<{ kind: 'json' | 'md'; text: string } | null>(null);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [showSettings, setShowSettings] = useState(false);

  const mount = (next: BlockJSON) => {
    setDoc(next);
    setGen((g) => g + 1);
    setPanel(null);
  };
  /** Change settings and remount, carrying the live document over (history resets). */
  const update = (patch: Partial<Settings>) => {
    const e = editor.current;
    if (e) setDoc(docToJSON(e.doc));
    setSettings((s) => ({ ...s, ...patch }));
    setGen((g) => g + 1);
  };
  const toggleFeature = (name: string, on: boolean) => {
    update({ off: on ? settings.off.filter((n) => n !== name) : [...settings.off, name] });
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
          <button onClick={() => setShowSettings((v) => !v)} aria-pressed={showSettings}>Réglages</button>
          <button onClick={() => { setSettings(initialSettings); mount(seed); }}>Réinitialiser</button>
        </span>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {showSettings && (
        <div className="settings-panel">
          <label className="settings-row">
            <span>pleine largeur</span>
            <input type="checkbox" checked={settings.fullWidth} onChange={(e) => update({ fullWidth: e.target.checked })} />
          </label>
          <label className="settings-row">
            <span>largeur max</span>
            <input type="range" min={420} max={1100} step={4} value={settings.maxWidth} disabled={settings.fullWidth} onChange={(e) => update({ maxWidth: Number(e.target.value) })} />
            <output>{settings.fullWidth ? '100%' : `${settings.maxWidth}px`}</output>
          </label>
          <label className="settings-row">
            <span>marges latérales</span>
            <input type="range" min={0} max={120} step={2} value={settings.padX} onChange={(e) => update({ padX: Number(e.target.value) })} />
            <output>{settings.padX}px</output>
          </label>
          <label className="settings-row">
            <span>lecture seule</span>
            <input type="checkbox" checked={settings.readOnly} onChange={(e) => update({ readOnly: e.target.checked })} />
          </label>
          <label className="settings-row">
            <span>topologie</span>
            <select value={settings.topology} onChange={(e) => update({ topology: e.target.value as Settings['topology'] })}>
              <option value="per-block">un hôte par bloc (D1)</option>
              <option value="single-host">hôte unique à la racine</option>
            </select>
          </label>
          <div className="settings-row">
            <span>features</span>
            <span className="settings-features">
              {TOGGLABLE.map((f) => (
                <label key={f.name}>
                  <input type="checkbox" checked={!settings.off.includes(f.name)} onChange={(e) => toggleFeature(f.name, e.target.checked)} />
                  {f.label}
                </label>
              ))}
            </span>
          </div>
        </div>
      )}
      <div className="demo-body" style={{ maxHeight: '70vh' }}>
        <Pane key={gen} initial={doc} settings={settings} onReady={(e) => { editor.current = e; }} />
      </div>
      {panel && <pre className="debug-panel">{panel.text}</pre>}
      {dragging && <div className="drop-overlay">Déposez votre fichier .md</div>}
    </div>
  );
}
