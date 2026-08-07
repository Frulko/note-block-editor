import { Plugin, TextFileView, type WorkspaceLeaf } from 'obsidian';
import { Editor, docFromJSON, uuidv7, type BlockJSON } from '@nbe/core';
import { EditorView } from '@nbe/dom';
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
    const root = this.editor.doc.blocks.get(this.editor.doc.rootId);
    const children = (root?.children ?? []).map((id) => toJSON(this.editor!, id));
    return blocksToMarkdown(children);
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
    this.view = new EditorView(this.mount, this.editor, {});
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
}

/** A block and its descendants, as the JSON the projection expects. */
function toJSON(editor: Editor, id: string): BlockJSON {
  const block = editor.doc.blocks.get(id)!;
  return {
    id: block.id,
    type: block.type,
    version: block.version,
    props: block.props,
    ...(block.text ? { text: block.text } : {}),
    children: (block.children ?? []).map((child) => toJSON(editor, child)),
  };
}

export default class CarnetPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CarnetView(leaf));

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
}
