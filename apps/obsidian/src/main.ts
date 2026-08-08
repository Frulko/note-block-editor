import { Plugin, PluginSettingTab, Setting, TextFileView, type App, type WorkspaceLeaf } from 'obsidian';
import { Editor, docFromJSON, docToJSON, uuidv7, type BlockJSON } from '@nbe/core';
import { EditorView, defaultFeatures, type EditorViewOptions } from '@nbe/dom';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';

/**
 * Carnet inside Obsidian — the editor, and nothing else.
 *
 * @remarks
 * The scope is the whole design. No comments, no presence, no CRDT, no `.nbe/`
 * directory, no workspace. This plugin edits **one file at a time, in place**,
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
 * **It does not hijack Markdown.** Registering as the handler for every `.md`
 * file would take Obsidian's own editor away from people who did not ask, so
 * the view is opt-in per file, through a command and the view switcher.
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
  theme: '',
  features: {},
};

/** The chrome features a user may sensibly turn off; the input core stays. */
const OPTIONAL_FEATURES: ReadonlyArray<{ name: string; label: string; desc: string }> = [
  { name: 'slash-menu', label: 'Menu slash', desc: 'Le menu d’insertion ouvert en tapant « / ».' },
  { name: 'mentions', label: 'Mentions', desc: 'L’autocomplétion ouverte en tapant « @ ».' },
  { name: 'gutter', label: 'Gouttière', desc: 'Le bouton + et la poignée de glisser-déposer au survol.' },
  { name: 'format-toolbar', label: 'Barre de mise en forme', desc: 'La barre flottante sur une sélection de texte.' },
  { name: 'block-toolbar', label: 'Barre de bloc', desc: 'La barre d’outils par bloc au survol.' },
  { name: 'link-hover', label: 'Carte de lien', desc: 'La carte d’édition au survol d’un lien.' },
  { name: 'database', label: 'Bases de données', desc: 'Les vues de base de données interactives.' },
];

/** Project the vault settings onto the editor's options, defaults preserved. */
function viewOptions(s: CarnetSettings): EditorViewOptions {
  const opts: EditorViewOptions = {
    spellcheck: s.spellcheck,
    columns: s.columns,
    readOnly: s.readOnly,
  };
  // readOnly's default is "no features at all"; only pick features when editing
  if (!s.readOnly) opts.features = defaultFeatures.filter((f) => s.features[f.name] !== false);
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

/** A page document wrapping freshly parsed blocks. */
function pageOf(markdown: string): BlockJSON {
  return {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: {},
    children: markdownToBlocks(markdown),
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
    return blocksToMarkdown(page.children ?? []);
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
  }

  async onClose(): Promise<void> {
    this.view?.destroy();
    this.view = null;
    this.editor = null;
  }

  private build(markdown: string): void {
    if (!this.mount) return;
    this.loading = true;
    this.view?.destroy();
    this.mount.empty();

    this.editor = new Editor({ doc: docFromJSON(pageOf(markdown)) });
    this.view = new EditorView(this.mount, this.editor, viewOptions(this.plugin.settings));
    /*
     * `requestSave` is Obsidian's debounced writer, and letting it own the
     * timing is the point: it already knows about conflicts, external changes
     * and shutdown, and a second save policy beside it would be a way to lose
     * an edit rather than a way to be faster.
     */
    this.editor.on(() => {
      if (this.loading) return;
      this.requestSave();
    });
    this.loading = false;
  }

  /** Rebuild with the current settings, keeping the document being edited. */
  refresh(): void {
    this.build(this.getViewData());
  }
}

export default class CarnetPlugin extends Plugin {
  settings: CarnetSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CarnetView(leaf, this));
    this.addSettingTab(new CarnetSettingTab(this.app, this));

    this.addCommand({
      id: 'open-in-carnet',
      name: 'Ouvrir cette note dans Carnet',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const file = this.app.workspace.getActiveFile();
        if (!leaf || !file || file.extension !== 'md') return false;
        if (!checking) void leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
        return true;
      },
    });

    this.addCommand({
      id: 'back-to-markdown',
      name: 'Revenir à l’éditeur Markdown',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const file = this.app.workspace.getActiveFile();
        if (!leaf || leaf.view.getViewType() !== VIEW_TYPE || !file) return false;
        if (!checking) void leaf.setViewState({ type: 'markdown', state: { file: file.path } });
        return true;
      },
    });
  }

  /** Persist the settings and rebuild every open Carnet view with them. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
          t.setValue(s.features[f.name] !== false).onChange((v) => {
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
