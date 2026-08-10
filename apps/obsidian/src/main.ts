import { Plugin, TFile, WorkspaceLeaf, type ViewState } from 'obsidian';
import { mermaidStyles } from '@nbe/blocks-mermaid';
import { HOST_COMMANDS } from './commands';
import { CarnetSettingTab, DEFAULT_SETTINGS, type CarnetSettings } from './settings';
import { CarnetView, VIEW_TYPE } from './view';

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
 * This file is the Obsidian side of it and nothing else — the plugin object,
 * its commands and its patches. The editing surface is `view.ts`, the vault
 * settings `settings.ts`, the block list and the Markdown projection
 * `document.ts`, the `editor:*` table `commands.ts`, the threads
 * `comments.ts`.
 *
 * @module @nbe/obsidian
 */
export default class CarnetPlugin extends Plugin {
  settings: CarnetSettings = { ...DEFAULT_SETTINGS };
  /** Files the user explicitly sent back to Obsidian's Markdown editor. */
  private readonly asMarkdown = new Set<string>();

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
    // no status-bar count of our own: core's already reads the file, and the
    // view keeps it live while typing — see `CarnetView.recount`
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

    /*
     * ponytail: a bare method patch on `app.commands`, restored on unload —
     * the same technique and the same caveat as the `setViewState` patch above.
     * There is no public seam: `executeCommandById` is what the Format menu,
     * the Insert menu, the mobile toolbar and every hotkey bound to them all
     * go through, and it is the only place that sees them.
     */
    const commands = (this.app as unknown as { commands?: { executeCommandById?: (id: string, ...rest: unknown[]) => boolean } })
      .commands;
    if (commands?.executeCommandById) {
      const original = commands.executeCommandById;
      const plugin = this;
      commands.executeCommandById = function (id: string, ...rest: unknown[]) {
        const handler = HOST_COMMANDS[id];
        const view = handler ? plugin.app.workspace.getActiveViewOfType(CarnetView) : null;
        // false means "not mine after all" — the command falls through to
        // Obsidian and behaves exactly as it did before
        if (view && handler!(view)) return true;
        return original.call(this, id, ...rest);
      };
      this.register(() => {
        commands.executeCommandById = original;
      });
    }

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

    /*
     * Right-click a note in the explorer, or its tab, and open it here.
     *
     * The command palette already had this, and a command is not where anyone
     * looks: the file explorer is. `file-menu` is the same event Obsidian's
     * own "Open in new tab" hangs off, so the entry sits with the others
     * rather than beside them.
     */
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle('Ouvrir dans Carnet')
            .setIcon('notebook-pen')
            .onClick(() => {
              this.asMarkdown.delete(file.path);
              const target = leaf ?? this.app.workspace.getLeaf(false);
              void target.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
            }),
        );
      }),
    );

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
    /*
     * The palette layer, which is a whole layer rather than a list of
     * exceptions: a theme that fights Carnet's mapping will fight it in more
     * than one place, and picking them off one at a time is a setting per
     * complaint. Absent means "follow the vault", so the default writes
     * nothing.
     */
    if (this.settings.vaultPalette) delete document.body.dataset.carnetPalette;
    else document.body.dataset.carnetPalette = 'carnet';
    // same hook again, for the face the prose is set in; `sans` is what the
    // token layer already says, so the default leaves no attribute behind
    if (this.settings.typeface && this.settings.typeface !== 'sans') {
      document.body.dataset.nbeTypeface = this.settings.typeface;
    } else {
      delete document.body.dataset.nbeTypeface;
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
