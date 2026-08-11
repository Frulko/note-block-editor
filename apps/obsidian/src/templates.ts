import { Modal, Notice, Setting, TFile, TFolder, normalizePath, type App } from 'obsidian';
import { readFrontmatter, writeFrontmatter } from '@nbe/markdown';
import { COMMENTS_SECTION } from './comments';
import type CarnetPlugin from './main';
import type { CarnetSettings } from './settings';

/**
 * Modèles : a folder says what a new note in it may start from.
 *
 * @remarks
 * **A template is a note.** Not a form, not a JSON schema, not a record in the
 * plugin's data file — a note in the template folder, written in Carnet like
 * any other. That is the whole reason this feature is small: "create a
 * template" is `vault.create` and open the editor, "edit" is open the editor,
 * "rename" and "delete" are the file explorer, which already does both better
 * than a modal of ours would. The only thing the plugin has to remember is
 * *which* templates a folder proposes, and that is one `Record<string,
 * string[]>`.
 *
 * **The choice happens when the note opens, not when it is created.** The
 * obvious design was `vault.on('create')` — Templater's — writing the template
 * in before anyone sees the file. It is the wrong one here twice over: it has
 * to be guarded against the `create` storm Obsidian fires on vault load
 * (`onLayoutReady`), against files created by sync and by import, and against
 * racing the view that is opening the same file; and it decides *for* the
 * writer, when what was asked for is that they be offered the choice. Doing it
 * in the view deletes all four problems — the view already knows a note is
 * brand new and empty, because that is the same test that focuses its title.
 *
 * **Inheritance accumulates.** A template set on `Projets` is proposed in
 * `Projets/2026/Q3` as well, and a template set on `Projets/2026/Q3` joins it
 * rather than hiding it. Nearest first. The vault root (`''`) is a folder like
 * any other in this walk, so "proposed everywhere" needs no special case.
 *
 * @module
 */

/** A folder, then each of its parents, ending at the vault root (`''`). */
function* ancestors(folder: string): Generator<string> {
  for (let p = folder; ; p = p.slice(0, Math.max(0, p.lastIndexOf('/')))) {
    yield p;
    // the root is its own parent, so it has to be the exit rather than the
    // condition — `''.slice(0, 0)` is `''` and the walk would never end
    if (p === '') return;
  }
}

/** The templates offered in this folder: its own, then its parents'. */
export function templatesFor(s: CarnetSettings, folder: string): string[] {
  const out: string[] = [];
  for (const p of ancestors(folder))
    for (const t of s.templates[p] ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

/** Which folder in the chain proposes this template; `null` when none does. */
function sourceOf(s: CarnetSettings, folder: string, path: string): string | null {
  for (const p of ancestors(folder)) if ((s.templates[p] ?? []).includes(path)) return p;
  return null;
}

/** The notes that may serve as templates: whatever is in the template folder. */
export function templateNotes(app: App, s: CarnetSettings): TFile[] {
  const dir = s.templateFolder.trim();
  if (!dir) return [];
  const folder = app.vault.getAbstractFileByPath(normalizePath(dir));
  /*
   * ponytail: the folder itself, not its subfolders. Nest them if a vault ever
   * holds enough templates to want categories — `folder.children` becomes a
   * recursive walk and nothing else here changes.
   */
  return folder instanceof TFolder
    ? folder.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md')
    : [];
}

/**
 * A template's text, as the new note's text.
 *
 * @remarks
 * Two keys come out of the header on the way. `title:` because the new note
 * has a name of its own — the one being typed into the inline title at that
 * very moment — and a template carrying one would rename every note made from
 * it to « Compte rendu de réunion ». The comment threads because a discussion
 * is about the blocks it was left on; copied out, every note made from the
 * template would open with the same conversation already in its margin.
 *
 * Everything else is kept, `Frontmatter` verbatim rules included: a template
 * that declares `tags:` or `cssclasses:` is a template *for* notes that have
 * them, which is most of the point of writing one.
 */
export function templateText(raw: string): string {
  const { frontmatter, body } = readFrontmatter(raw);
  frontmatter.set('title', undefined);
  frontmatter.setSection(COMMENTS_SECTION, undefined);
  return writeFrontmatter(frontmatter, body);
}

/**
 * « Commencer avec un modèle », under the title of a note just created.
 *
 * @remarks
 * Buttons in the page, not a menu, and that is a constraint rather than a
 * preference: at this moment the caret is in the inline title, selected, so
 * the first thing typed names the note (`CarnetView.focusTitle`). `createMenu`
 * takes ArrowUp/ArrowDown/Enter at the document, in capture — the naming of
 * the note would stop working the moment a folder had a template. A row of
 * buttons takes no keys at all, and `mousedown` is cancelled so a click never
 * takes the caret out of the title either.
 *
 * Returns the row so the view can drop it on the first keystroke: someone who
 * started writing has answered the question.
 */
export function renderTemplateChoice(
  after: HTMLElement | null,
  plugin: CarnetPlugin,
  folder: string,
  onPick: (markdown: string) => void,
): HTMLElement | null {
  // the title is what the row goes under, and there is no second-best place:
  // appended to the scroller instead it would land beneath the whole note
  if (!after) return null;
  // a path that no longer resolves is a template that was deleted or moved;
  // silently dropped, because the alternative is an error about a file nobody
  // remembers naming, on a note they were only trying to write
  const files = templatesFor(plugin.settings, folder)
    .map((path) => plugin.app.vault.getAbstractFileByPath(path))
    .filter((f): f is TFile => f instanceof TFile);
  if (!files.length) return null;

  const row = createDiv({ cls: 'carnet-templates' });
  row.createSpan({ cls: 'carnet-templates-label', text: 'Commencer avec un modèle' });
  const button = (label: string, cls: string, onClick: () => void) => {
    const el = row.createEl('button', { cls, text: label });
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', onClick);
  };
  for (const file of files)
    button(file.basename, 'carnet-template', () => {
      row.remove();
      void plugin.app.vault
        .cachedRead(file)
        .then((raw) => onPick(templateText(raw)))
        .catch((err) => new Notice(err instanceof Error ? err.message : String(err)));
    });
  // the way out has to be as easy as the way in: a note that wants none of
  // them is the common case, and Notion offers exactly this button
  button('Page vide', 'carnet-template carnet-template-blank', () => row.remove());
  after.after(row);
  return row;
}

/**
 * « Modèles de Carnet… » on a folder: what a new note here may start from.
 *
 * @remarks
 * The list is the template folder's notes, with a switch each. A switch that
 * is on because a *parent* folder said so is shown as such and disabled —
 * turning it off here would have to mean "except in this branch", which is a
 * second kind of entry and an exception nobody has asked for yet.
 */
export class TemplateManager extends Modal {
  constructor(
    private readonly plugin: CarnetPlugin,
    /** The folder being configured; `''` is the vault root. */
    private readonly folder: string,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    const s = this.plugin.settings;
    const where = this.folder || 'tout le coffre';
    contentEl.empty();
    this.setTitle(`Modèles de « ${where} »`);
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `Les modèles activés sont proposés dans une note créée dans « ${where} », et dans ses sous-dossiers. Un modèle est une note comme une autre : elle se conçoit dans Carnet.`,
    });

    const notes = templateNotes(this.app, s);
    if (!notes.length)
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: s.templateFolder.trim()
          ? `Aucune note dans « ${s.templateFolder.trim()} ». Le bouton ci-dessous en crée une.`
          : 'Aucun dossier de modèles n’est défini dans les réglages de Carnet.',
      });

    for (const note of notes) {
      const from = sourceOf(s, this.folder, note.path);
      const inherited = from !== null && from !== this.folder;
      new Setting(contentEl)
        .setName(note.basename)
        .setDesc(inherited ? `Hérité de « ${from || 'tout le coffre'} »` : '')
        .addExtraButton((b) =>
          b
            .setIcon('pencil')
            .setTooltip('Modifier ce modèle')
            .onClick(() => {
              this.close();
              this.plugin.openInCarnet(note);
            }),
        )
        .addToggle((t) =>
          t
            .setValue(from !== null)
            .setDisabled(inherited)
            .onChange((v) => this.assign(note.path, v)),
        );
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Nouveau modèle')
        .setCta()
        .onClick(() => void this.create()),
    );
  }

  /** Propose this template in this folder, or stop proposing it. */
  private assign(path: string, on: boolean): void {
    const s = this.plugin.settings;
    const list = (s.templates[this.folder] ?? []).filter((p) => p !== path);
    if (on) list.push(path);
    // an empty array is an entry that says nothing; removing it keeps the data
    // file readable and every inheritance walk one step shorter
    if (list.length) s.templates[this.folder] = list;
    else delete s.templates[this.folder];
    void this.plugin.saveSettings();
  }

  /**
   * A new template is a new note, opened in Carnet.
   *
   * @remarks
   * Designing a template *is* writing a note, and this plugin is an editor for
   * notes — so there is no template designer to build, and nothing to keep in
   * sync with the editor when a block type is added. It is turned on for the
   * folder it was created from, because a template nobody can reach is not
   * something anyone meant to make.
   */
  private async create(): Promise<void> {
    const s = this.plugin.settings;
    const dir = normalizePath(s.templateFolder.trim() || 'Modèles');
    try {
      if (!(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder))
        await this.app.vault.createFolder(dir);
      const base = 'Nouveau modèle';
      let name = base;
      for (let n = 2; this.app.vault.getAbstractFileByPath(`${dir}/${name}.md`); n++)
        name = `${base} ${n}`;
      const file = await this.app.vault.create(`${dir}/${name}.md`, '');
      this.assign(file.path, true);
      this.close();
      this.plugin.openInCarnet(file);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err));
    }
  }
}
