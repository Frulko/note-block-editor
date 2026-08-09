import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useEditor, type Editor, type BlockJSON } from '@nbe/react';
import { PluginRegistry, docToJSON, memoryComments, type CommentThread, type Run } from '@nbe/core';
import {
  LOCALE_NAMES,
  defaultFeatures,
  exportFeature,
  findFeature,
  labelsFor,
  openCommentThread,
  perBlockTopology,
  singleHostTopology,
  wordCountFeature,
} from '@nbe/dom';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { CODE_THEMES } from '@nbe/blocks-code';
import { code } from '@nbe/blocks-code/dom';
import { callout } from '@nbe/blocks-callout/dom';
import { toc } from '@nbe/blocks-toc/dom';
import { mdx } from '@nbe/blocks-mdx/dom';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import { mermaidFeature, mermaidStyles } from '@nbe/blocks-mermaid/dom';

/**
 * The demo-page playground: the editor plus a debug bar — load a markdown
 * file (drag & drop or file picker), undo/redo, inspect the live document as
 * JSON or markdown, and a dat.gui-style settings panel driving the real
 * EditorView options (geometry, read-only, topology, feature set).
 */

/**
 * The block set this playground runs.
 *
 * @remarks
 * The same list feeds the editor and both markdown directions — a registry the
 * importer does not have is a code fence that comes back as a paragraph.
 */
const BLOCKS = [code, callout, toc, mdx, ...tableDomBlocks];
const PLUGINS = new PluginRegistry().registerAll(BLOCKS);

let n = 0;
const b = (type: string, text: string | Run[], props?: Record<string, unknown>, children?: BlockJSON[]): BlockJSON => ({
  id: `pg-${++n}`,
  type,
  version: 1,
  ...(props ? { props } : {}),
  text: typeof text === 'string' ? (text ? [{ text }] : []) : text,
  ...(children?.length ? { children } : {}),
});

const seed: BlockJSON = {
  id: 'pg-root',
  type: 'page',
  version: 1,
  children: [
    b('heading', 'Bac à sable', { level: 1 }),
    b('paragraph', [
      { text: 'Tapez ' },
      { text: '/', marks: [{ type: 'code' }] },
      { text: ' pour le menu de blocs, ou déposez ici un ' },
      { text: '.md', marks: [{ type: 'code' }] },
      { text: ', une image, un PDF.' },
    ]),
    b('table_of_contents', ''),
    b('heading', 'Écrire', { level: 2 }),
    b('to_do', 'Sélectionner du texte : gras, italique, code, lien…', { checked: true }),
    b('to_do', [
      { text: '…et ' },
      { text: 'le surlignage', marks: [{ type: 'background', attrs: { color: 'yellow' } }] },
      { text: ', x' },
      { text: '2', marks: [{ type: 'superscript' }] },
      { text: ' et H' },
      { text: '2', marks: [{ type: 'subscript' }] },
      { text: 'O (⌘. et ⌘,)' },
    ]),
    b('to_do', 'Alt+↑ / Alt+↓ déplacent le bloc, ⌘⌫ le supprime, ⌘⏎ coche', { checked: false }),
    b('to_do', 'Réglages : recherche ⌘F, export ⌘P, compteur de mots, langue', { checked: false }),
    b('toggle', 'Un toggle, avec des enfants', { collapsed: false }, [
      b('paragraph', 'Entrée depuis un toggle vide écrit à l’intérieur, pas en dessous.'),
      b('bulleted_list_item', 'Tab / Shift+Tab pour imbriquer'),
    ]),
    b('callout', 'Le DOM est une projection jetable du modèle — jamais la source de vérité.', { icon: '💡' }),
    b('heading', 'Code et diagrammes', { level: 2 }),
    b('code', 'const doc = docFromJSON(json);\neditor.dispatch((tx) => tx.insertText(id, 0, "salut"));', {
      language: 'ts',
    }),
    b('code', 'graph LR\n  A[Modèle] --> B[Transaction]\n  B --> C[Projection DOM]\n  C --> A', {
      language: 'mermaid',
      mermaidMode: 'both',
    }),
    b('heading', 'Tableaux', { level: 2 }),
    b('table', '', {}, [
      b('table_row', '', {}, [b('table_cell', 'Bloc'), b('table_cell', 'Markdown')]),
      b('table_row', '', {}, [b('table_cell', 'sommaire'), b('table_cell', '[TOC]')]),
      b('table_row', '', {}, [b('table_cell', 'diagramme'), b('table_cell', '```mermaid')]),
    ]),
    b('paragraph', ''),
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
  locale: string;
  codeTheme: string;
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
  locale: 'fr',
  codeTheme: 'one',
  topology: 'per-block',
  // ⌘F and ⌘P belong to the browser here: on the web they are opt-in, and this
  // page is the web. The checkboxes are two clicks away.
  off: ['find', 'export'],
};

/** Everything mountable, defaults first; the plumbing (input, keymap, …) is not listed. */
const ALL_FEATURES = [...defaultFeatures, findFeature, exportFeature, wordCountFeature, mermaidFeature];

const TOGGLABLE = [
  { name: 'slash-menu', label: 'menu /' },
  { name: 'mentions', label: 'mentions @' },
  { name: 'gutter', label: 'poignée + ⋮⋮' },
  { name: 'format-toolbar', label: 'barre de formatage' },
  { name: 'block-toolbar', label: 'barre de bloc' },
  { name: 'link-hover', label: 'survol des liens' },
  { name: 'find', label: 'recherche ⌘F' },
  { name: 'export', label: 'export ⌘P' },
  { name: 'word-count', label: 'compteur de mots' },
  { name: 'mermaid', label: 'diagrammes Mermaid' },
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
    labels: labelsFor(settings.locale),
    blocks: BLOCKS,
    topology: settings.topology === 'single-host' ? singleHostTopology : perBlockTopology,
    features: ALL_FEATURES.filter((f) => !settings.off.includes(f.name)),
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
  /*
   * A real store, not a list of strings. The bubble is `openCommentThread`
   * from `@nbe/dom` — the same one the demo app and the Obsidian plugin use —
   * and it needs somewhere to put a reply and somewhere to take one back;
   * `prompt()`, which was here, could do neither.
   */
  const comments = useRef(memoryComments());
  const [threads, setThreads] = useState<CommentThread[]>([]);
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

  // the mermaid feature ships its CSS as a string, like a block plugin's
  // `styles` — in an effect, because this component is also rendered on the
  // server to produce the page it hydrates into
  useEffect(() => {
    const el = Object.assign(document.createElement('style'), { textContent: mermaidStyles });
    document.head.append(el);
    return () => el.remove();
  }, []);

  // the list below the editor reads the store rather than being written to
  // alongside it, so a reply or a deletion made in the bubble shows here too
  useEffect(() => comments.current.onChange(() => setThreads(comments.current.list())), []);
  const resetComments = () => {
    for (const thread of comments.current.list()) comments.current.delete(thread.id);
  };

  // the syntax palette is one attribute; no remount, so changing it keeps the
  // caret and the undo stack
  useEffect(() => {
    if (settings.codeTheme === 'one') delete document.body.dataset['nbeCodeTheme'];
    else document.body.dataset['nbeCodeTheme'] = settings.codeTheme;
  }, [settings.codeTheme]);

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
    if (f)
      void f
        .text()
        .then((text) =>
          mount({ id: 'md-root', type: 'page', version: 1, children: markdownToBlocks(text, { plugins: PLUGINS }) }),
        );
  };
  const show = (kind: 'json' | 'md') => {
    const e = editor.current;
    if (!e) return;
    if (panel?.kind === kind) return setPanel(null);
    const json = docToJSON(e.doc);
    setPanel({
      kind,
      text:
        kind === 'json'
          ? JSON.stringify(json, null, 2)
          : blocksToMarkdown(json.children ?? [], { plugins: PLUGINS }),
    });
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
              <div
                className="settings-menu"
                role="dialog"
                aria-label="Réglages de l’éditeur"
                /* the list grew: cap it at what is left below the button, or the
                   last checkboxes sit under the fold with no way to reach them */
                style={{ top: at.top, left: at.left, maxHeight: `calc(100vh - ${at.top + 16}px)` }}
              >
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
                <Row label="langue" hint="toute l’interface de l’éditeur">
                  <select value={settings.locale} onChange={(e) => update({ locale: e.target.value })}>
                    {Object.entries(LOCALE_NAMES).map(([code, name]) => (
                      <option key={code} value={code}>{name}</option>
                    ))}
                  </select>
                </Row>
                <Row label="thème du code">
                  {/* an attribute on <body>, so this one does not remount the editor */}
                  <select
                    value={settings.codeTheme}
                    onChange={(e) => setSettings((s) => ({ ...s, codeTheme: e.target.value }))}
                  >
                    {CODE_THEMES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
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
          <button onClick={() => { setSettings(initialSettings); resetComments(); mount(seed); }}>Réinitialiser</button>
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
            if (!editor.current) return;
            openCommentThread({
              editor: editor.current,
              store: comments.current,
              blockId,
              author: { id: 'visiteur', name: 'Visiteur' },
              labels: labelsFor(settings.locale),
              locale: settings.locale,
            });
          }}
        />
      </div>
      {threads.length > 0 && (
        <div className="demo-comments">
          <b>Commentaires ({threads.length})</b>
          {threads.flatMap((t) => t.messages).map((m) => (
            <p key={m.id}>{m.authorName ?? 'Anonyme'} — {m.body}</p>
          ))}
        </div>
      )}
      {panel && <pre className="debug-panel">{panel.text}</pre>}
      {dragging && <div className="drop-overlay">Déposez votre fichier .md</div>}
    </div>
  );
}
