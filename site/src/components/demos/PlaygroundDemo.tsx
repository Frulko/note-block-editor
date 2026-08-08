import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
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
  spellcheck: boolean;
  columns: boolean;
  comments: boolean;
  topology: 'per-block' | 'single-host';
  off: string[]; // disabled feature names
}

const initialSettings: Settings = {
  fullWidth: true,
  maxWidth: 708,
  padX: 18,
  readOnly: false,
  spellcheck: false,
  columns: false,
  comments: true,
  topology: 'per-block',
  off: [],
};

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
function Pane({
  initial,
  settings,
  onReady,
  onComment,
}: {
  initial: BlockJSON;
  settings: Settings;
  onReady: (e: Editor) => void;
  onComment: (blockId: string) => void;
}) {
  const { ref } = useEditor({
    initialContent: initial,
    onReady,
    maxWidth: settings.fullWidth ? '100%' : `${settings.maxWidth}px`,
    padding: { top: '16px', bottom: '24px', x: `${settings.padX}px` },
    readOnly: settings.readOnly,
    spellcheck: settings.spellcheck,
    columns: settings.columns,
    topology: settings.topology === 'single-host' ? singleHostTopology : perBlockTopology,
    features: defaultFeatures.filter((f) => !settings.off.includes(f.name)),
    // no host, no button: the right gutter is empty rather than decorative
    ...(settings.comments ? { onComment, commentAuthor: { id: 'visiteur', name: 'Visiteur' } } : {}),
  });
  return <div ref={ref} />;
}

/** One labelled control in the settings menu. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </label>
  );
}

/** A checkbox that looks like a switch. */
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </span>
  );
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
  const [comments, setComments] = useState<string[]>([]);
  const menu = useRef<HTMLSpanElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  /*
   * The frame clips its overflow to round its corners, so a menu positioned
   * against the button would be cut off. `position: fixed` escapes that — no
   * ancestor here establishes a containing block for it — at the price of
   * carrying the coordinates ourselves.
   */
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const MENU_WIDTH = 320;

  const openSettings = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, r.right - MENU_WIDTH) });
    setShowSettings((v) => !v);
  };

  /* A dropdown that stays open when you click elsewhere is a panel wearing a
     costume. Escape and an outside press both close it. */
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowSettings(false);
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setShowSettings(false);
    };
    // a menu anchored to a scrolling page has to follow it, or close
    const onScroll = () => setShowSettings(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll);
    };
  }, [showSettings]);

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
          <span className="settings-anchor" ref={menu}>
            <button ref={trigger} onClick={openSettings} aria-expanded={showSettings} aria-haspopup="true">
              Réglages <span className="chevron" aria-hidden="true">▾</span>
            </button>
            {showSettings && (
              <div className="settings-menu" role="dialog" aria-label="Réglages de l’éditeur" style={{ top: at.top, left: at.left }}>
                <p className="settings-group">Géométrie</p>
                <Row label="pleine largeur">
                  <Switch checked={settings.fullWidth} onChange={(v) => update({ fullWidth: v })} />
                </Row>
                <Row label="largeur max">
                  <input type="range" min={420} max={1100} step={4} value={settings.maxWidth} disabled={settings.fullWidth} onChange={(e) => update({ maxWidth: Number(e.target.value) })} />
                  <output>{settings.fullWidth ? '100%' : `${settings.maxWidth}px`}</output>
                </Row>
                <Row label="marges">
                  <input type="range" min={0} max={120} step={2} value={settings.padX} onChange={(e) => update({ padX: Number(e.target.value) })} />
                  <output>{settings.padX}px</output>
                </Row>

                <p className="settings-group">Comportement</p>
                <Row label="lecture seule">
                  <Switch checked={settings.readOnly} onChange={(v) => update({ readOnly: v })} />
                </Row>
                <Row label="correction ortho.">
                  <Switch checked={settings.spellcheck} onChange={(v) => update({ spellcheck: v })} />
                </Row>
                <Row label="commentaires" hint="bouton 💬 à droite">
                  <Switch checked={settings.comments} onChange={(v) => update({ comments: v })} />
                </Row>
                <Row label="colonnes" hint="expérimental : drop latéral">
                  <Switch checked={settings.columns} onChange={(v) => update({ columns: v })} />
                </Row>
                <Row label="topologie">
                  <select value={settings.topology} onChange={(e) => update({ topology: e.target.value as Settings['topology'] })}>
                    <option value="per-block">un hôte par bloc (D1)</option>
                    <option value="single-host">hôte unique à la racine</option>
                  </select>
                </Row>

                <p className="settings-group">Fonctionnalités</p>
                <div className="settings-features">
                  {TOGGLABLE.map((f) => (
                    <label key={f.name}>
                      <input type="checkbox" checked={!settings.off.includes(f.name)} onChange={(e) => toggleFeature(f.name, e.target.checked)} />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </span>
          <button onClick={() => { setSettings(initialSettings); setComments([]); mount(seed); }}>Réinitialiser</button>
        </span>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown" hidden onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <div className="demo-body" style={{ maxHeight: '70vh' }}>
        <Pane
          key={gen}
          initial={doc}
          settings={settings}
          onReady={(e) => { editor.current = e; }}
          onComment={(blockId) => {
            const body = prompt('Votre commentaire');
            if (body?.trim()) setComments((c) => [...c, `${blockId.slice(0, 8)} — ${body}`]);
          }}
        />
      </div>
      {comments.length > 0 && (
        <div className="demo-comments">
          <b>Commentaires ({comments.length})</b>
          {comments.map((c, i) => <p key={i}>{c}</p>)}
        </div>
      )}
      {panel && <pre className="debug-panel">{panel.text}</pre>}
      {dragging && <div className="drop-overlay">Déposez votre fichier .md</div>}
    </div>
  );
}
