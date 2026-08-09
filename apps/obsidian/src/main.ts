import {
  Keymap,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextFileView,
  WorkspaceLeaf,
  normalizePath,
  type App,
  type TFile,
  type ViewState,
} from 'obsidian';
import { Editor, PluginRegistry, docFromJSON, docToJSON, getBlock, isCollapsed, uuidv7, type BlockJSON } from '@nbe/core';
import {
  EditorView,
  builtinBlocks,
  caretLine,
  defaultFeatures,
  documentSize,
  exportFeature,
  findFeature,
  labelsFor,
  LOCALE_NAMES,
  openExport,
  openFind,
  wordCountFeature,
  type DocumentSize,
  type EditorViewOptions,
} from '@nbe/dom';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { applyAnchors, createNoteComments, readComments, restoreAnchors, writeComments } from './comments';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import { code } from '@nbe/blocks-code/dom';
import { CODE_THEMES } from '@nbe/blocks-code';
import { mermaidStyles } from '@nbe/blocks-mermaid';
import { mermaidFeature } from '@nbe/blocks-mermaid/dom';
import { floatingTocFeature, toc } from '@nbe/blocks-toc/dom';
import { mdx } from '@nbe/blocks-mdx/dom';

/**
 * Carnet inside Obsidian — the editor, and nothing else.
 *
 * @remarks
 * The scope is the whole design. No presence, no CRDT, no `.nbe/` directory,
 * no workspace. Comments *were* on that list, and came off it the honest way:
 * the objection was that a thread has nowhere to live when the Markdown is
 * the document, and a sidecar file would leave the discussion behind the
 * first time a note is carried away on a USB stick. The note carries them
 * instead, in Obsidian's own `%%…%%` syntax — `src/comments.ts`. This plugin edits **one file at a time, in place**,
 * and that is what makes it coherent: §10 puts the canonical JSON above the
 * Markdown projection, and a plugin that owned a *workspace* would invert that
 * — Obsidian would own the files and L0 would become a cache of them. An
 * editor does not own a workspace, so the question never arises. Here Markdown
 * *is* the document, because there is nothing else for it to be.
 *
 * **Why it is worth building.** The gap
 * (`docs/research/competitive-landscape.md`) is that no editor offers
 * Notion-grade WYSIWYG over plain Markdown files. Obsidian is on the wrong
 * side of it and structurally cannot cross: Live Preview is CodeMirror 6, and
 * plugin authors have neither access to its built-in editor extensions nor a
 * way to extend the parser. This aims at exactly that.
 *
 * **`TextFileView` is the right base class**, and not by coincidence — its
 * contract is literally "here is the text, hand it back when asked", which is
 * `markdownToBlocks` in and `blocksToMarkdown` out. Obsidian keeps ownership
 * of loading, saving, renaming, conflict handling and the file explorer; we
 * supply an editing surface and stay out of everything else.
 *
 * **It does not hijack Markdown uninvited.** Taking over every `.md` file
 * would remove Obsidian's own editor from people who did not ask, so by
 * default the view is opt-in per file, through a command and the view
 * switcher. The « éditeur par défaut » setting flips that for people who did
 * ask; the escape hatch (per-file « revenir à Markdown ») always works.
 *
 * **Block ids are per session.** Markdown has no place to keep them and this
 * plugin adds no sidecar, so ids are regenerated on load. Undo lives in the
 * session, which is what an editor needs; deep links and backlinks are a
 * workspace feature and belong to the app.
 *
 * @module @nbe/obsidian
 */

export const VIEW_TYPE = 'carnet-editor';

/**
 * Everything data-shaped in {@link EditorViewOptions}, as vault settings.
 * The function-shaped options (page hosts, assets, topology, recognizers,
 * custom blocks, labels) are code, not settings, and stay out.
 */
interface CarnetSettings {
  maxWidth: string;
  padTop: string;
  padBottom: string;
  padX: string;
  spellcheck: boolean;
  columns: boolean;
  readOnly: boolean;
  /** Open every Markdown file in Carnet instead of Obsidian's editor. */
  defaultEditor: boolean;
  /**
   * Which way the token layer points: follow the vault, or force one.
   *
   * A vault theme that is dark on some pages and light on others is not
   * exotic — a print stylesheet, a light snippet on a dark theme — and a
   * reader who wants the editor light regardless had no way to say so.
   */
  themeMode: 'vault' | 'light' | 'dark';
  /** Which syntax palette code blocks use. See `CODE_THEMES`. */
  codeTheme: string;
  /** The editor's interface language. `LOCALE_NAMES` lists what ships. */
  locale: string;
  /** Comments, kept in the note itself as Obsidian comment syntax. */
  comments: boolean;
  /** One CSS custom property per line: `--nbe-accent-rgb: 220 38 38`. */
  theme: string;
  /** Chrome features toggled off, by feature name; absent means on. */
  features: Record<string, boolean>;
}

const DEFAULT_SETTINGS: CarnetSettings = {
  maxWidth: '',
  padTop: '',
  padBottom: '',
  padX: '',
  spellcheck: false,
  columns: false,
  readOnly: false,
  defaultEditor: false,
  themeMode: 'vault',
  codeTheme: 'one',
  // the vault is most likely French if this plugin is installed; the editor's
  // own default is English and every other language is one setting away
  locale: 'fr',
  comments: true,
  theme: '',
  features: {},
};

/**
 * The chrome features a user may sensibly turn off; the input core stays.
 *
 * `on: false` makes one opt-*in* instead. Absent from the saved settings means
 * this default, not "enabled" — a floating outline over every note is a
 * preference, and the wrong one to impose on someone who never asked.
 */
const OPTIONAL_FEATURES: ReadonlyArray<{ name: string; label: string; desc: string; on?: boolean }> = [
  { name: 'slash-menu', label: 'Menu slash', desc: 'Le menu d’insertion ouvert en tapant « / ».' },
  { name: 'mentions', label: 'Mentions', desc: 'L’autocomplétion ouverte en tapant « @ ».' },
  { name: 'gutter', label: 'Gouttière', desc: 'Le bouton + et la poignée de glisser-déposer au survol.' },
  { name: 'format-toolbar', label: 'Barre de mise en forme', desc: 'La barre flottante sur une sélection de texte.' },
  { name: 'block-toolbar', label: 'Barre de bloc', desc: 'La barre d’outils par bloc au survol.' },
  { name: 'link-hover', label: 'Carte de lien', desc: 'La carte d’édition au survol d’un lien.' },
  { name: 'database', label: 'Bases de données', desc: 'Les vues de base de données interactives.' },
  { name: 'find', label: 'Recherche ⌘F', desc: 'Rechercher dans la note ouverte, surlignage des résultats.' },
  { name: 'export', label: 'Export ⌘P', desc: 'Markdown, texte ou impression PDF de la note ouverte.' },
  { name: 'word-count', label: 'Compteur de mots', desc: 'Mots, caractères et temps de lecture sous la note.' },
  { name: 'mermaid', label: 'Diagrammes Mermaid', desc: 'Dessine les blocs ```mermaid, avec Aperçu / Code / Les deux.' },
  {
    name: 'floating-toc',
    label: 'Sommaire flottant',
    desc: 'Les titres de la note, dans un panneau qui suit le défilement et souligne la section en cours de lecture. Masqué sur un volet étroit.',
    on: false,
  },
];

/** Whether a feature is on: the saved setting, else the feature's own default. */
function featureOn(s: CarnetSettings, name: string): boolean {
  return s.features[name] ?? OPTIONAL_FEATURES.find((f) => f.name === name)?.on ?? true;
}

/** Project the vault settings onto the editor's options, defaults preserved. */
function viewOptions(s: CarnetSettings): EditorViewOptions {
  const opts: EditorViewOptions = {
    labels: labelsFor(s.locale),
    spellcheck: s.spellcheck,
    columns: s.columns,
    readOnly: s.readOnly,
    // the table is a plugin: without it a note's `| a | b |` stays a paragraph
    blocks: BLOCKS,
  };
  // readOnly's default is "no features at all"; only pick features when editing
  /*
   * `findFeature` is not in the defaults — in a browser `⌘F` belongs to the
   * browser. A pane is not a browser window: there is no page find to take
   * here, so this host offers it and lets the setting turn it off.
   */
  if (!s.readOnly)
    opts.features = [
      ...defaultFeatures,
      findFeature,
      exportFeature,
      wordCountFeature,
      mermaidFeature,
      floatingTocFeature,
    ].filter((f) => featureOn(s, f.name));
  if (s.maxWidth.trim()) opts.maxWidth = s.maxWidth.trim();
  const padding: { top?: string; bottom?: string; x?: string } = {};
  if (s.padTop.trim()) padding.top = s.padTop.trim();
  if (s.padBottom.trim()) padding.bottom = s.padBottom.trim();
  if (s.padX.trim()) padding.x = s.padX.trim();
  if (Object.keys(padding).length) opts.padding = padding;
  const theme: Record<string, string> = {};
  for (const line of s.theme.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) theme[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (Object.keys(theme).length) opts.theme = theme;
  return opts;
}

/**
 * The blocks the view renders and the projections a note is parsed and written
 * with — one list, read by both. They used to be two, and the table of
 * contents was in only one of them: it rendered fine, was written as an
 * `<!-- nbe:table_of_contents -->` marker on save, and came back as that
 * literal text on the next open. A plugin registered on one side only is
 * always that bug, so there is now no side to forget.
 */
const BLOCKS = [...builtinBlocks, code, toc, ...tableDomBlocks];

const MARKDOWN_PLUGINS = new PluginRegistry().registerAll(BLOCKS);

/** A page document wrapping freshly parsed blocks. */
function pageOf(markdown: string): BlockJSON {
  return {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: {},
    children: applyAnchors(markdownToBlocks(markdown, { plugins: MARKDOWN_PLUGINS })),
  };
}

class CarnetView extends TextFileView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: CarnetPlugin,
  ) {
    super(leaf);
  }

  private editor: Editor | null = null;
  private view: EditorView | null = null;
  /** The host we mount into, kept apart from Obsidian's own containers. */
  private mount: HTMLElement | null = null;
  /**
   * True while we are loading a file into the editor.
   *
   * @remarks
   * Mounting dispatches through the same path a keystroke does, so without
   * this the load would mark the file dirty and Obsidian would write it back
   * immediately — reformatting a note the user only opened. A user who opens a
   * file and closes it must leave no diff.
   */
  private loading = false;

  /**
   * The open note's comment threads.
   *
   * @remarks
   * Per view, not per plugin: this editor holds one file, and threads that
   * outlived it would be threads about somebody else's blocks.
   */
  private comments: ReturnType<typeof createNoteComments> | null = null;

  getViewType(): string {
    return VIEW_TYPE;
  }

  getIcon(): string {
    return 'notebook-pen';
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'Carnet';
  }

  /** Obsidian asks for the file's content. This is the L1 projection. */
  getViewData(): string {
    if (!this.editor) return this.data;
    /*
     * `docToJSON`, not a walk of our own. This used to hand-roll the same
     * recursion — a second implementation of a tested function, which is the
     * duplication this codebase keeps paying to remove, and which I wrote here
     * without noticing. It would have drifted the first time `Block` gained a
     * field.
     */
    const page = docToJSON(this.editor.doc) as BlockJSON;
    const blocks = this.comments ? restoreAnchors(page.children ?? []) : (page.children ?? []);
    const markdown = blocksToMarkdown(blocks, { plugins: MARKDOWN_PLUGINS });
    // the threads go back at the end, in Obsidian's own comment syntax, so the
    // discussion travels with the file and reading mode shows none of it
    return this.comments ? writeComments(markdown, this.comments.store.list()) : markdown;
  }

  /** Obsidian hands over the file's content, on open and on external change. */
  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear || !this.editor) this.build(data);
    else this.build(data); // an external edit replaces the document wholesale
  }

  clear(): void {
    this.data = '';
    this.build('');
  }

  async onOpen(): Promise<void> {
    this.mount = this.contentEl.createDiv({ cls: 'carnet-host' });
    this.registerDomEvent(this.mount, 'click', (e) => this.followLink(e));
    this.registerDomEvent(this.mount, 'keydown', (e) => this.onEditorKey(e));
    // an external rename (file explorer, sync) must reach the inline title;
    // Obsidian mutates the TFile in place, so identity survives the rename
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file === this.file && this.inlineTitleEl) this.inlineTitleEl.textContent = this.file.basename;
      }),
    );
  }

  /**
   * Obsidian-style navigation: a wikilink opens the note, a plain link the
   * browser, and Cmd/Ctrl+click opens in a new pane ({@link Keymap.isModEvent}).
   *
   * @remarks
   * `openLinkText` is the vault's own resolver — shortest-path matching,
   * unresolved-link creation, everything — so we hand it the link text and
   * stay out of the rest. The editor's `onOpenPage` hook is not the right
   * seam here: it speaks page ids, and a vault has none.
   */
  private followLink(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const open = (linktext: string) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(linktext, this.file?.path ?? '', Keymap.isModEvent(e));
    };
    const mention = target.closest('.nbe-m-mention') as HTMLElement | null;
    if (mention) {
      const linktext = mention.dataset['target'] || mention.dataset['pageId'] || mention.textContent || '';
      if (linktext) open(linktext);
      return;
    }
    const pageLink = target.closest('.nbe-t-link_to_page') as HTMLElement | null;
    if (pageLink && this.editor) {
      const p = getBlock(this.editor.doc, pageLink.dataset['blockId']!).props;
      const linktext = String(p['target'] || p['title'] || '');
      if (linktext) open(linktext);
      return;
    }
    const anchor = target.closest('a.nbe-m-link') as HTMLAnchorElement | null;
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (!href) return;
      e.preventDefault();
      // a scheme means the outside world; anything else is a vault-relative
      // path, which is Obsidian's to resolve
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href);
      else open(decodeURI(href).replace(/\.md$/, ''));
    }
  }

  /**
   * The rename has to survive the element being taken away.
   *
   * @remarks
   * The title committed on `blur`, and removing a focused element from the
   * document does not fire one — so typing a new name and then switching notes
   * (⌘O, the file explorer, a link) discarded the rename silently, which is
   * most of "you cannot always rename from the editor". Obsidian calls this
   * before it unloads the file, and `this.file` is still the old one here,
   * which is exactly what {@link commitTitle} needs.
   *
   * Before `super`, not after: the base class saves the note's *contents* and
   * then clears the view, and a save that runs after the rename writes to the
   * file Obsidian has already moved.
   */
  async onUnloadFile(file: TFile): Promise<void> {
    await this.commitTitle();
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    await this.commitTitle();
    this.view?.destroy();
    this.view = null;
    this.editor = null;
  }

  private inlineTitleEl: HTMLElement | null = null;

  /** The inline title: the filename, edited in place like Obsidian's own. */
  private buildTitle(host: HTMLElement): void {
    const title = host.createDiv({ cls: 'carnet-title' });
    this.inlineTitleEl = title;
    title.textContent = this.file?.basename ?? '';
    try {
      title.contentEditable = 'plaintext-only';
    } catch {
      title.contentEditable = 'true';
    }
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        title.blur();
        this.enterNote();
      } else if (e.key === 'Escape') {
        title.textContent = this.file?.basename ?? '';
        title.blur();
      }
    });
    title.addEventListener('blur', () => void this.commitTitle());
  }

  /** Put the caret at the end of the title, the way ArrowUp should leave it. */
  private focusTitle(): void {
    const title = this.inlineTitleEl;
    if (!title) return;
    title.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(title);
    range.collapse(false);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /**
   * ArrowUp off the top of the note lands in the title.
   *
   * @remarks
   * The other half of "the title must always be editable": until now the only
   * way into it was the mouse, so on a keyboard it was not reachable at all —
   * and Obsidian's own inline title has been reachable this way since it
   * shipped. The keymap leaves the key alone when there is no block above, so
   * this only ever sees the event the editor declined; `caretLine` is the
   * editor's own answer to "is the caret on the first visual line", which is
   * the part that a wrapped paragraph makes hard.
   */
  private onEditorKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowUp' || e.defaultPrevented) return;
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const view = this.view;
    const editor = this.editor;
    if (!view || !editor) return;
    const sel = editor.selection;
    if (sel?.kind !== 'text' || !isCollapsed(sel)) return;
    const doc = editor.doc;
    if (sel.head.blockId !== getBlock(doc, doc.rootId).children[0]) return;
    if (!caretLine(view)?.first) return;
    e.preventDefault();
    this.focusTitle();
  }

  /** Enter from the title lands in a fresh first block (Notion), reusing an empty one. */
  private enterNote(): void {
    const editor = this.editor;
    const view = this.view;
    if (!editor || !view) return;
    const doc = editor.doc;
    const firstId = getBlock(doc, doc.rootId).children[0];
    const first = firstId ? doc.blocks.get(firstId) : undefined;
    if (first && first.type === 'paragraph' && !(first.text ?? []).length) return view.focusBlock(first.id, 0);
    const block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      text: [],
      children: [],
      parentId: doc.rootId,
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block, index: 0 }), { origin: 'input' });
    view.focusBlock(block.id, 0);
  }

  /** Rename the file to match the edited title; revert the text on refusal. */
  private async commitTitle(): Promise<void> {
    const title = this.inlineTitleEl;
    if (!title || !this.file) return;
    const name = (title.textContent ?? '').trim();
    if (!name || name === this.file.basename) {
      title.textContent = this.file.basename;
      return;
    }
    const folder = this.file.parent?.path ?? '';
    try {
      // fileManager, not vault: this is the rename that updates backlinks
      await this.app.fileManager.renameFile(this.file, normalizePath(`${folder}/${name}.${this.file.extension}`));
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err));
    }
    title.textContent = this.file.basename;
  }

  private build(markdown: string): void {
    if (!this.mount) return;
    this.loading = true;
    this.view?.destroy();
    this.mount.empty();
    this.buildTitle(this.mount);

    const opts = viewOptions(this.plugin.settings);
    // the title supplies the top spacing; keep the editor close under it
    if (!this.plugin.settings.padTop.trim()) opts.padding = { ...opts.padding, top: '12px' };

    // the threads come out of the note before it is parsed as blocks; the
    // anchors stay in the text, where `applyAnchors` turns them into marks
    const note = this.plugin.settings.comments ? readComments(markdown) : { markdown, threads: [] };
    this.comments = this.plugin.settings.comments
      ? createNoteComments(note.threads, () => {
          if (!this.loading) this.requestSave();
        })
      : null;

    this.editor = new Editor({ doc: docFromJSON(pageOf(note.markdown)) });
    this.view = new EditorView(this.mount, this.editor, {
      ...opts,
      // comments live in the note itself, so this host can offer them at all
      ...(this.comments
        ? {
            onComment: (blockId, author) => this.comments?.onComment(this.editor!, blockId, author),
            commentAuthor: { id: 'obsidian', name: 'Vous' },
          }
        : {}),
      // the `@` picker completes against the vault's notes; the id IS the
      // link text, because a vault resolves by name, not by uuid
      onSearchPages: (query) => {
        const q = query.toLowerCase();
        return this.app.vault
          .getMarkdownFiles()
          .filter((f) => f.basename.toLowerCase().includes(q))
          .slice(0, 10)
          .map((f) => ({ pageId: f.basename, title: f.basename }));
      },
      // a pasted or dropped image is an attachment, and the vault already has
      // a policy for where those go — so we ask it rather than invent a folder
      onStoreAsset: (blob) => this.storeAttachment(blob),
      resolveAssetUrl: (src) => this.resolveAttachment(src),
    });
    /*
     * `requestSave` is Obsidian's debounced writer, and letting it own the
     * timing is the point: it already knows about conflicts, external changes
     * and shutdown, and a second save policy beside it would be a way to lose
     * an edit rather than a way to be faster.
     */
    this.editor.on(() => {
      this.plugin.refreshStatus();
      if (this.loading) return;
      this.requestSave();
    });
    this.loading = false;
    this.plugin.refreshStatus();
  }

  /**
   * Write a pasted/dropped binary into the vault, return the link to persist.
   *
   * @remarks
   * The src that goes in the document is the **vault path**, not an opaque
   * `asset:` ref, and that is the whole point of this host: the file is the
   * document (§10 inverted, as the module note explains), so an image has to
   * be a file Obsidian can see, back up and sync like any other attachment.
   * `getAvailablePathForAttachment` is the vault's own policy — the user's
   * attachment folder, the collision suffix — so nothing here decides where
   * images live.
   *
   * URL-encoded because the path is going into `![](…)`, where a `)` or a `#`
   * in a folder name would end the link early. {@link resolveAttachment}
   * decodes on the way back, as {@link followLink} already does for links.
   */
  private async storeAttachment(blob: Blob): Promise<string> {
    const ext = blob.type.split('/')[1]?.replace(/\+xml$/, '') || 'png';
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const name = (blob as File).name || `Pasted image ${stamp}.${ext}`;
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, this.file?.path);
    await this.app.vault.createBinary(path, await blob.arrayBuffer());
    return encodeURI(path);
  }

  /**
   * A stored src as something an `<img>` can load.
   *
   * @remarks
   * Also what makes images in *existing* notes appear: `![](attachments/x.png)`
   * is a vault path, which a browser cannot fetch — it needs `app://`, and only
   * the vault can produce it. Link resolution is Obsidian's (shortest-path
   * matching), so a bare filename works the way it does everywhere else.
   *
   * ponytail: `![[x.png]]` embeds are still text — the Markdown parser has no
   * wikilink-image rule. Add one there if vaults full of them need it.
   */
  private resolveAttachment(src: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http(s), data:, already resolved
    const file = this.app.metadataCache.getFirstLinkpathDest(decodeURI(src), this.file?.path ?? '');
    return file ? this.app.vault.getResourcePath(file) : src;
  }

  /** Rebuild with the current settings, keeping the document being edited. */
  refresh(): void {
    this.build(this.getViewData());
  }

  /** Words, characters and reading time, or `null` before the editor exists. */
  size(): DocumentSize | null {
    return this.editor ? documentSize(this.view!) : null;
  }

  /** Raise the find bar. False when the feature is switched off. */
  find(): boolean {
    return !!this.view && openFind(this.view);
  }

  /** Raise the export menu. False when the feature is switched off. */
  exportNote(): boolean {
    return !!this.view && openExport(this.view);
  }
}

export default class CarnetPlugin extends Plugin {
  settings: CarnetSettings = { ...DEFAULT_SETTINGS };
  /** Files the user explicitly sent back to Obsidian's Markdown editor. */
  private readonly asMarkdown = new Set<string>();
  /** The status-bar word count. Removed with the plugin by Obsidian itself. */
  private status: HTMLElement | null = null;

  /** Re-read the active Carnet note's size into the status bar. */
  refreshStatus(): void {
    const el = this.status;
    if (!el) return;
    const size = this.app.workspace.getActiveViewOfType(CarnetView)?.size();
    // an empty item still takes its separator in the bar, so hide it outright
    el.style.display = size ? '' : 'none';
    if (!size) return;
    el.textContent = labelsFor(this.settings.locale)
      .wordCount.replace('{words}', String(size.words))
      .replace('{characters}', String(size.characters))
      .replace('{minutes}', String(size.minutes));
  }

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CarnetView(leaf, this));
    /*
     * The mermaid feature ships its CSS as a string rather than in the plugin
     * stylesheet, because Obsidian loads exactly one of those and it is the
     * editor's. Injected here, removed with the plugin.
     */
    const mermaidCss = document.head.appendChild(
      Object.assign(document.createElement('style'), { textContent: mermaidStyles }),
    );
    this.register(() => mermaidCss.remove());
    this.addSettingTab(new CarnetSettingTab(this.app, this));
    /*
     * Obsidian's own word count is a *Markdown editor* feature: it reads the
     * active `MarkdownView`'s CodeMirror instance, and there is no seam for a
     * `TextFileView` to answer instead — so in a Carnet note the status bar
     * simply went blank. This is that count, from the same `documentSize` the
     * in-note counter uses, hidden whenever the active view is somebody else's.
     */
    this.status = this.addStatusBarItem();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshStatus()));
    this.refreshStatus();
    this.syncTheme();
    this.registerEvent(this.app.workspace.on('css-change', () => this.syncTheme()));

    /*
     * « Éditeur par défaut » : Obsidian refuses a second view for `.md`, so
     * the only seam is the one every open goes through — `setViewState` —
     * rewritten from `markdown` to Carnet when the setting says so. The same
     * approach as the Kanban plugin. `asMarkdown` is the per-file escape
     * hatch, session-scoped on purpose: "montre-moi le Markdown" is a request
     * about now, not a preference to persist.
     *
     * ponytail: a bare prototype patch, restored on unload. If another plugin
     * patches the same method after us, unload order decides who wins —
     * monkey-around if that ever bites someone.
     */
    const plugin = this;
    const original = WorkspaceLeaf.prototype.setViewState;
    WorkspaceLeaf.prototype.setViewState = function (state: ViewState, eState?: unknown) {
      const file = (state.state as Record<string, unknown> | undefined)?.['file'];
      if (
        plugin.settings.defaultEditor &&
        state.type === 'markdown' &&
        typeof file === 'string' &&
        file.endsWith('.md') &&
        !plugin.asMarkdown.has(file)
      ) {
        return original.call(this, { ...state, type: VIEW_TYPE }, eState);
      }
      return original.call(this, state, eState);
    };
    this.register(() => {
      WorkspaceLeaf.prototype.setViewState = original;
    });

    this.addCommand({
      id: 'open-in-carnet',
      name: 'Ouvrir cette note dans Carnet',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const file = this.app.workspace.getActiveFile();
        if (!leaf || !file || file.extension !== 'md') return false;
        if (!checking) {
          this.asMarkdown.delete(file.path);
          void leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
        }
        return true;
      },
    });

    /*
     * ⌘F and ⌘P as Obsidian *commands*, not only as capture-phase listeners.
     *
     * The editor takes both keys before the document sees them, which is what
     * a plugin has to do when the application already owns a shortcut — and it
     * is a race the application should win, because it is the application's
     * hotkey table the user opens to rebind it. Obsidian dispatching to the
     * editor is the same feature reached the right way round: it survives
     * whatever else is bound to the key, it appears in the palette, and it is
     * rebindable. `checkCallback` answers false when the feature is off, so a
     * disabled setting greys the command out instead of doing nothing.
     */
    const noteCommand = (id: string, name: string, key: string, run: (view: CarnetView) => boolean) =>
      this.addCommand({
        id,
        name,
        hotkeys: [{ modifiers: ['Mod'], key }],
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(CarnetView);
          if (!view) return false;
          // asking costs nothing and is the only way to know the feature is on
          if (checking) return true;
          return run(view);
        },
      });
    noteCommand('find', 'Rechercher dans la note', 'f', (view) => view.find());
    noteCommand('export', 'Exporter la note', 'p', (view) => view.exportNote());

    this.addCommand({
      id: 'back-to-markdown',
      name: 'Revenir à l’éditeur Markdown',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const file = this.app.workspace.getActiveFile();
        if (!leaf || leaf.view.getViewType() !== VIEW_TYPE || !file) return false;
        if (!checking) {
          this.asMarkdown.add(file.path);
          void leaf.setViewState({ type: 'markdown', state: { file: file.path } });
        }
        return true;
      },
    });
  }

  onunload(): void {
    delete document.body.dataset.nbeTheme;
  }

  /**
   * Tell the token layer which way Obsidian is pointing.
   *
   * @remarks
   * Carnet's channels flip on `prefers-color-scheme` unless a host says
   * otherwise, and a vault's theme has nothing to do with the OS's — someone
   * running a light system and a dark vault was getting dark ink on a dark
   * page. `data-nbe-theme` is the documented hook for saying so, and putting it
   * on `<body>` is what reaches the menus portaled out there as well as the
   * editor. `css-change` is the event Obsidian fires when the theme changes.
   */
  syncTheme(): void {
    const mode = this.settings.themeMode;
    document.body.dataset.nbeTheme =
      mode === 'vault' ? (document.body.hasClass('theme-dark') ? 'dark' : 'light') : mode;
    // the same shape as the editor's own theme hook: an attribute on <body>,
    // which reaches the chrome portaled out of the editor as well as the page
    if (this.settings.codeTheme && this.settings.codeTheme !== 'one') {
      document.body.dataset.nbeCodeTheme = this.settings.codeTheme;
    } else {
      delete document.body.dataset.nbeCodeTheme;
    }
  }

  /** Persist the settings and rebuild every open Carnet view with them. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.syncTheme();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      (leaf.view as CarnetView).refresh();
    }
  }
}

class CarnetSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CarnetPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName('Commentaires')
      .setDesc('Commenter un bloc depuis la marge droite. Les fils sont écrits dans la note elle-même, en syntaxe de commentaire Obsidian (%%…%%) — invisibles en mode lecture, et ils voyagent avec le fichier.')
      .addToggle((t) =>
        t.setValue(s.comments).onChange((v) => {
          s.comments = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Langue')
      .setDesc('La langue de l’interface de l’éditeur — menus, infobulles, messages. Elle ne touche pas au contenu des notes.')
      .addDropdown((d) =>
        d
          .addOptions(LOCALE_NAMES)
          .setValue(s.locale)
          .onChange((v) => {
            s.locale = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Thème')
      .setDesc('Carnet suit le thème du coffre par défaut. Forcer clair ou sombre change l’éditeur et son chrome flottant, sans toucher au reste d’Obsidian.')
      .addDropdown((d) =>
        d
          .addOptions({ vault: 'Suivre le coffre', light: 'Clair', dark: 'Sombre' })
          .setValue(s.themeMode)
          .onChange((v) => {
            s.themeMode = v as CarnetSettings['themeMode'];
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Coloration du code')
      .setDesc('La palette des blocs de code. Chaque thème a sa version claire et sa version sombre ; celle qui s’applique suit le thème ci-dessus.')
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(CODE_THEMES.map((t) => [t.id, t.label])))
          .setValue(s.codeTheme)
          .onChange((v) => {
            s.codeTheme = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Éditeur par défaut')
      .setDesc('Ouvre les fichiers Markdown dans Carnet plutôt que dans l’éditeur d’Obsidian. « Revenir à l’éditeur Markdown » reste disponible fichier par fichier.')
      .addToggle((t) =>
        t.setValue(s.defaultEditor).onChange((v) => {
          s.defaultEditor = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Largeur du texte')
      .setDesc('Largeur maximale de la colonne de texte. Vide = 708px (Notion) ; « 100% » désactive le centrage.')
      .addText((t) =>
        t.setPlaceholder('708px').setValue(s.maxWidth).onChange((v) => {
          s.maxWidth = v;
          save();
        }),
      );

    const pads: Array<[keyof CarnetSettings & ('padTop' | 'padBottom' | 'padX'), string]> = [
      ['padTop', 'Marge haute'],
      ['padBottom', 'Marge basse'],
      ['padX', 'Marges latérales'],
    ];
    for (const [key, name] of pads) {
      new Setting(containerEl)
        .setName(name)
        .setDesc('Toute valeur CSS ; vide = défaut de l’éditeur.')
        .addText((t) =>
          t.setPlaceholder('ex. 24px').setValue(s[key]).onChange((v) => {
            s[key] = v;
            save();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Correction orthographique')
      .setDesc('Demande au navigateur de vérifier l’orthographe dans l’éditeur.')
      .addToggle((t) =>
        t.setValue(s.spellcheck).onChange((v) => {
          s.spellcheck = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Colonnes par glisser-déposer')
      .setDesc('Expérimental : déposer un bloc à côté d’un autre crée deux colonnes.')
      .addToggle((t) =>
        t.setValue(s.columns).onChange((v) => {
          s.columns = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Lecture seule')
      .setDesc('Affiche les notes sans permettre de les modifier.')
      .addToggle((t) =>
        t.setValue(s.readOnly).onChange((v) => {
          s.readOnly = v;
          save();
        }),
      );

    new Setting(containerEl).setName('Fonctionnalités').setHeading();
    for (const f of OPTIONAL_FEATURES) {
      new Setting(containerEl)
        .setName(f.label)
        .setDesc(f.desc)
        .addToggle((t) =>
          t.setValue(featureOn(s, f.name)).onChange((v) => {
            s.features[f.name] = v;
            save();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Thème')
      .setDesc('Variables CSS du token layer, une par ligne. Ex. : --nbe-accent-rgb: 220 38 38')
      .addTextArea((t) =>
        t.setPlaceholder('--nbe-accent-rgb: 220 38 38\n--nbe-radius: 2px').setValue(s.theme).onChange((v) => {
          s.theme = v;
          save();
        }),
      );
  }
}
