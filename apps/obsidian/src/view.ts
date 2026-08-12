import {
  Keymap,
  Notice,
  Scope,
  TextFileView,
  TFile,
  WorkspaceLeaf,
  debounce,
  normalizePath,
  requestUrl,
  type Modifier,
} from 'obsidian';
import {
  Editor,
  docFromJSON,
  docToJSON,
  getBlock,
  isCollapsed,
  selectedBlocks,
  textCaret,
  textLength,
  uuidv7,
  type BlockId,
  type BlockJSON,
} from '@nbe/core';
import {
  EditorView,
  caretLine,
  findHits,
  insertBlocksAt,
  openExport,
  openFind,
  openIconPicker,
  refreshCommentMarkers,
  reveal,
} from '@nbe/dom';
import { Frontmatter, documentToMarkdown, readFrontmatter, slugify } from '@nbe/markdown';
import { createNoteComments, readComments, restoreAnchors, writeComments } from './comments';
import { MARKDOWN_PLUGINS, pageOf } from './document';
import { decodePath, iconEl, iconSrc } from './icons';
import { titleFromHtml } from './link-title';
import { viewOptions } from './settings';
import { renderTemplateChoice } from './templates';
import type CarnetPlugin from './main';

/**
 * The editing surface itself: one file, mounted in one pane.
 *
 * @module
 */

export const VIEW_TYPE = 'carnet-editor';

/**
 * A drag that started inside Obsidian, which is not a `DataTransfer`.
 *
 * @remarks
 * Dragging a note out of the file explorer puts an `obsidian://open?…` URL on
 * the event and the *file itself* on `app.dragManager.draggable` — the second
 * being what every part of Obsidian reads, including its own editor. It is not
 * in the published typings, hence the shape declared here.
 *
 * ponytail: an undocumented field, read and never written, behind a
 * `?.` — a version that renames it turns vault drops off and breaks nothing
 * else. The URL on the event is the fallback if that ever happens.
 */
interface VaultDrag {
  type: string;
  file?: unknown;
  files?: unknown[];
  linktext?: string;
}

/**
 * How many times `needle` appears in `text` before `end` — the rank of a
 * search hit among its twins. Case-insensitive, because `findHits` is.
 */
function occurrencesBefore(text: string, needle: string, end: number): number {
  const haystack = text.slice(0, end).toLowerCase();
  const lower = needle.toLowerCase();
  let n = 0;
  for (let at = haystack.indexOf(lower); at !== -1; at = haystack.indexOf(lower, at + lower.length)) n++;
  return n;
}

/** Vault paths that the image block should render rather than the file card. */
const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/**
 * The block a file dropped from the vault becomes.
 *
 * @remarks
 * A note is a *link*: `link_to_page` is what writes back as `[[Nom]]`, which
 * is how a vault spells a link to a note, so the drop leaves the file exactly
 * as Obsidian's own editor would have.
 *
 * Anything else is imported where it stands, at the path the vault already
 * keeps it at — nothing is copied. An image goes in as `![[chemin]]`
 * (`wiki: true`), Obsidian's own spelling, raw rather than URL-encoded because
 * that is what a wikilink target is. The file card is a Markdown link instead,
 * where a space or a parenthesis would end the link early, so that one is
 * encoded; {@link CarnetView.resolveAttachment} decodes on the way back and
 * hands the block an `app://` URL — which is what makes a dropped PDF preview
 * in place rather than sit there as a name.
 */
function blockFor(file: TFile): BlockJSON {
  const base = { id: uuidv7(), version: 1, text: [] };
  if (file.extension === 'md')
    return { ...base, type: 'link_to_page', props: { target: file.basename, title: file.basename } };
  if (IMAGE_EXT.test(file.extension)) return { ...base, type: 'image', props: { src: file.path, wiki: true } };
  return { ...base, type: 'file', props: { src: encodeURI(file.path), name: file.name, size: file.stat.size } };
}

/**
 * What a URL is called, fetched through the vault.
 *
 * @remarks
 * `requestUrl` rather than `fetch`: it goes through Electron's main process, so
 * it is not subject to CORS — which is the whole reason this hook belongs to
 * the host and not to `@nbe/dom`, where no code could make the request at all.
 *
 * `null` for anything it could not read as an HTML page — a refusal, a PDF, a
 * scheme that is not http. The link card reads that as "no title" and keeps the
 * shortened URL it had already put in the field.
 */
async function resolveTitle(url: string): Promise<{ title?: string } | null> {
  if (!/^https?:/i.test(url)) return null;
  try {
    const res = await requestUrl({ url, method: 'GET', throw: false });
    if (res.status >= 400) return null;
    const type = String(res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? '');
    // an image or a PDF has no `<title>`, and reading megabytes to find that
    // out is the one cost worth avoiding here
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    const title = titleFromHtml(res.text);
    return title ? { title } : null;
  } catch {
    return null;
  }
}

const MOD: Modifier[] = ['Mod'];
const MOD_SHIFT: Modifier[] = ['Mod', 'Shift'];

/**
 * The keys the editor owns, taken back from Obsidian's hotkey table.
 *
 * @remarks
 * Obsidian listens for `keydown` on `window` in the **capture** phase, and any
 * key its table binds is executed there and then `stopPropagation`'d — so the
 * editor's own listener, further down the tree, never saw it. That is the
 * whole of "⌘B, ⌘I, ⌘K et ⌘E ne font rien ici": they were being spent on
 * `editor:toggle-bold` and friends, which want a Markdown view and quietly do
 * nothing without one. The key was gone and nothing had happened.
 *
 * A view scope is the seam for exactly that — Obsidian asks
 * `activeLeaf.view.scope` before its own table — and a handler that returns
 * anything other than `false` means *handled, and no `preventDefault`*: the
 * app stops looking, the event keeps travelling, and the editor gets its key.
 * The parent is `app.scope`, so everything not listed here (⌘O, ⌘P, ⌘S, ⌘W,
 * ⌘T, ⌘F…) is still Obsidian's, including this plugin's own commands.
 *
 * ⌘C/⌘V/⌘X and ⌘Z are listed although core binds none of them: a vault where
 * the user has bound one is a vault where copy stops working, and that is not
 * a bug anyone would think to look for here.
 *
 * ponytail: ⌘, stays Obsidian's settings — subscript is on the selection
 * toolbar, and a Mac app that swallows ⌘, is a broken Mac app.
 */
const OWNED_KEYS = 'a b c d e i k u v x y z . Enter Backspace Delete'.split(' ');
/** The same, with Shift: strikethrough, plain paste, redo, moving a block. */
const OWNED_SHIFT_KEYS = 's x v z ArrowUp ArrowDown'.split(' ');

export class CarnetView extends TextFileView {
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

  /**
   * The note's YAML header, held for as long as the note is open.
   *
   * @remarks
   * Held rather than re-read, because it is *edited* while the note is open —
   * the title goes in it, the threads go in it — and because everything in it
   * that is not ours has to come back out untouched. `Frontmatter` keeps the
   * source of every key nobody changed, so a vault's `tags`, `aliases` and
   * `cssclasses` survive a save by this editor exactly as they were written.
   */
  private frontmatter = new Frontmatter();

  /**
   * Keep Obsidian's *own* status-bar word count honest while typing.
   *
   * @remarks
   * The core « Statistiques » plugin counts from `vault.cachedRead` on
   * `file-open`, so in a Carnet note it showed the bytes on disk and then
   * froze until the next save. This plugin used to answer that with a second
   * status-bar item of its own, which is how a note ended up with two counts
   * side by side, disagreeing.
   *
   * `quick-preview` is the event core already listens to for exactly this —
   * it is what Obsidian's own editor fires while a note is being typed into,
   * and its handler recounts whenever the file is the active one. So there is
   * nothing to render, nothing to localise and nothing to keep in sync: we
   * hand core the text and it owns the display, in the vault's language.
   *
   * ponytail: debounced, because the text costs one full Markdown
   * serialisation. Half a second reads as live for a word count; raise it if
   * a very long note ever feels heavy while typing.
   */
  private readonly recount = debounce(
    () => {
      if (this.file) this.app.workspace.trigger('quick-preview', this.file, this.getViewData());
    },
    500,
    false,
  );

  getViewType(): string {
    return VIEW_TYPE;
  }

  getIcon(): string {
    return 'notebook-pen';
  }

  getDisplayText(): string {
    return this.displayTitle() || 'Carnet';
  }

  /**
   * What the note is called: its `title` property when it has one, its filename
   * otherwise.
   *
   * @remarks
   * The two differ whenever a title holds something a filename cannot — « Daily
   * 10/08 », « Réunion : 2026 » — which used to mean the title simply lost the
   * character: {@link commitTitle} reduced it through `slugify` and what came
   * back on screen was the reduction. The file still has to be named something
   * a filesystem accepts, so the *name* is still the slug; the title itself now
   * lives in the frontmatter, which is where a document's metadata belongs and
   * what Obsidian's own front-matter-title plugins read. The tab, the inline
   * title and this view all show it.
   */
  private displayTitle(file: TFile | null = this.file): string {
    // a number too: `title: 2026` is a title someone typed, and YAML reads it
    // as a number whatever they meant by it
    const title = this.frontmatter.get('title');
    const text = typeof title === 'string' || typeof title === 'number' ? String(title).trim() : '';
    return text || file?.basename || '';
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
    // the threads go back into the note's header, so the discussion travels
    // with the file and no reader mistakes it for prose
    if (this.comments) writeComments(this.frontmatter, this.comments.store.list());
    return documentToMarkdown({ frontmatter: this.frontmatter, blocks }, { plugins: MARKDOWN_PLUGINS });
  }

  /**
   * Obsidian hands over the file's content, on open and on external change.
   *
   * @remarks
   * **Including after our own save**, which is where "I reordered a block and
   * it scrolled to the top" came from. Every edit calls `requestSave`, the
   * write raises a vault event, and the view is handed back the bytes it just
   * produced — a full rebuild, and `this.mount` *is* the scroller, so emptying
   * it clamps `scrollTop` to 0 and the content coming back does not put it
   * back. The reader loses their place because they moved a block.
   *
   * Comparing is the sane and simple version of not doing that: if the file on
   * disk is already what this view would write, there is nothing to rebuild.
   * It costs one serialisation, on an event that only fires when a file
   * changes — the same work the save that caused it already did.
   */
  setViewData(data: string, clear: boolean): void {
    const same = !clear && !!this.editor && data === this.getViewData();
    this.data = data;
    if (same) return;
    this.build(data);
  }

  clear(): void {
    this.data = '';
    this.build('');
  }

  /**
   * Where Obsidian asked us to land, until the document is there to land in:
   * the text to find, and *which* of its occurrences.
   */
  private pendingReveal: { needle: string; nth: number } | null = null;

  /**
   * Obsidian says *where* in the note to go: a search hit, a heading anchor.
   *
   * @remarks
   * This is what makes the search pane work on a Carnet note. A result opens
   * the file and then hands the view an ephemeral state — `{ match: { content,
   * matches } }`, the file's text and the offsets of the hit inside it — which
   * `MarkdownView` turns into a CodeMirror selection. Without this method the
   * note opened at the top and the reader was left to find their own result,
   * which for a hit two thousand words down is not opening it at all.
   *
   * The offsets are into the *Markdown*, and this editor holds blocks, so they
   * are not usable as positions. The matched **text** is, and the editor
   * already has the function that finds text in a document — the one ⌘F uses.
   * A heading link (`[[Note#Titre]]`) arrives as `subpath` and is the same
   * question with the `#` taken off.
   *
   * **Which** occurrence matters as much as which word. A note with three
   * `iframe` in it gets three results in the sidebar, and every one of them
   * used to land on the first — the offsets say which, and counting the same
   * text before them in the file gives its rank, which is the rank to take in
   * the document. Not a proof: text that lives in Markdown syntax and not in
   * the rendered document (a URL, an anchor `%%^id%%`) shifts the count. It is
   * right for prose, which is what a search result is.
   *
   * Deferred until the document is whole: Obsidian sets the state right after
   * handing over the file, and on a long note the blocks the hit is in have
   * not been rendered yet.
   *
   * ponytail: `line` is not handled — a Markdown line number is not a block,
   * and nothing in Obsidian sends one at a note this view can open. It would
   * need the projection to keep a line map.
   */
  setEphemeralState(state: unknown): void {
    const s = (state ?? {}) as { match?: { content?: string; matches?: number[][] }; subpath?: string };
    const at = s.match?.matches?.[0];
    const content = s.match?.content ?? '';
    const needle = at ? content.slice(at[0]!, at[1]!) : (s.subpath ?? '').replace(/^#+/, '').trim();
    if (!needle) return;
    this.pendingReveal = { needle, nth: at ? occurrencesBefore(content, needle, at[0]!) : 0 };
    void this.view?.whenComplete().then(() => this.revealPending());
  }

  /** Scroll to the text Obsidian asked for, and select it. */
  private revealPending(): void {
    const pending = this.pendingReveal;
    const view = this.view;
    if (!pending || !view) return;
    this.pendingReveal = null;
    const hits = findHits(view, pending.needle);
    // the note may hold fewer than the file does; the last one beats none
    const hit = hits[Math.min(pending.nth, hits.length - 1)];
    if (!hit) return;
    const el = view.blockEl(hit.blockId);
    // `start`, not `nearest`: arriving at a search result means arriving at the
    // passage it is in, the same reason a contents entry scrolls that way
    if (el) reveal(el, 'start');
    view.editor.setSelection(
      { kind: 'text', anchor: { blockId: hit.blockId, offset: hit.from }, head: { blockId: hit.blockId, offset: hit.to } },
      'api',
    );
    view.syncDomSelection();
  }

  async onOpen(): Promise<void> {
    // see OWNED_KEYS: the editor's shortcuts, reclaimed from the app's table
    const scope = new Scope(this.app.scope);
    for (const key of OWNED_KEYS) scope.register(MOD, key, () => true);
    for (const key of OWNED_SHIFT_KEYS) scope.register(MOD_SHIFT, key, () => true);
    this.scope = scope;

    this.mount = this.contentEl.createDiv({ cls: 'carnet-host' });
    this.registerDomEvent(this.mount, 'click', (e) => this.followLink(e));
    this.registerDomEvent(this.mount, 'keydown', (e) => this.onEditorKey(e));
    this.registerDomEvent(this.mount, 'dragover', (e) => this.onVaultDragOver(e));
    this.registerDomEvent(this.mount, 'dragleave', () => this.endVaultDrag());
    this.registerDomEvent(this.mount, 'drop', (e) => this.onVaultDrop(e));
    // an external rename (file explorer, sync) must reach the inline title;
    // Obsidian mutates the TFile in place, so identity survives the rename
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file === this.titleFile && this.inlineTitleEl)
          this.inlineTitleEl.textContent = this.displayTitle(this.titleFile);
      }),
    );

    /*
     * The note may already be here.
     *
     * `build` needs the mount and gives up quietly without one — and nothing
     * ever asked again, so a `setViewData` that landed before this ran left a
     * blank pane for good. That is "parfois rien ne s'affiche": it is a race,
     * so it is intermittent, and it is likeliest where the view is created
     * lazily, which is what a phone does with every pane it is not showing.
     *
     * The file, not the text: a brand-new note is empty, so testing the *data*
     * skipped the rebuild every single time — no editor and, above it, no
     * title, which is why a note called « Untitled » could not be renamed from
     * here. An empty note is a note.
     */
    if (this.file) this.build(this.data);
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

  /*
   * The clipboard, for the events that never reached the editor.
   *
   * @remarks
   * Obsidian listens for `copy`, `cut` and `paste` on `window` and hands each
   * one to `activeLeaf.view.handle*` — unless it has already been claimed, or
   * the focused element is "a text field", which it decides with
   * `contentEditable === 'true'`. Every leaf here is
   * `contenteditable="plaintext-only"`, so that test says no and this view is
   * the one asked to deal with it.
   *
   * Which is the seam that was missing. The editor's own listeners sit on its
   * content element, so they only see a clipboard event dispatched *inside* it
   * — and the whole point of the cross-block topology is that a selection is
   * not always in a focused leaf: a range painted across blocks, a block
   * selection, a click that landed on the gutter all leave the focus outside
   * `.nbe-leaf`, so the event fires at `<body>` and goes straight past the
   * editor to the window. Nothing was broken; the event simply flew over.
   *
   * Forwarding re-dispatches it where those listeners are, carrying the same
   * `DataTransfer` — so a copy still serialises from the model and a paste
   * still reads the flavours the editor knows. Obsidian only calls this when
   * `defaultPrevented` is false, which is exactly when the editor has *not*
   * already handled it, so nothing can be copied or pasted twice.
   *
   * ponytail: `handleCopy`/`handleCut`/`handlePaste` are not in the published
   * typings — the same undocumented-but-load-bearing seam as `dragManager`
   * above. A version that renames them leaves the clipboard where it is today
   * and breaks nothing else.
   */
  private forwardClipboard(e: ClipboardEvent): void {
    const content = this.view?.content;
    if (!content || e.defaultPrevented || content.contains(e.target as Node)) return;
    const forwarded = new ClipboardEvent(e.type, {
      clipboardData: e.clipboardData,
      bubbles: true,
      cancelable: true,
    });
    // `dispatchEvent` is false when something called `preventDefault`: the
    // editor took it, so the original must be cancelled too
    if (!content.dispatchEvent(forwarded)) e.preventDefault();
  }

  handleCopy(e: ClipboardEvent): void {
    this.forwardClipboard(e);
  }

  handleCut(e: ClipboardEvent): void {
    this.forwardClipboard(e);
  }

  handlePaste(e: ClipboardEvent): void {
    this.forwardClipboard(e);
  }

  /** The files an in-progress vault drag is carrying, notes and all. */
  private draggedFiles(): TFile[] {
    const drag = (this.app as unknown as { dragManager?: { draggable?: VaultDrag } }).dragManager?.draggable;
    if (!drag) return [];
    const items = drag.files ?? (drag.file ? [drag.file] : []);
    const files = items.filter((f): f is TFile => f instanceof TFile);
    // dragging a *link* (from a note, from the search pane) carries link text
    // rather than a file; the vault resolves it the way it resolves any link
    if (!files.length && drag.linktext) {
      const target = this.app.metadataCache.getFirstLinkpathDest(drag.linktext, this.file?.path ?? '');
      if (target) files.push(target);
    }
    return files;
  }

  private onVaultDragOver(e: DragEvent): void {
    // the editor answers an OS file drop itself, and that one is already
    // cancelled by the time it reaches here
    if (e.defaultPrevented || !this.draggedFiles().length) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    // the same affordance a dropped OS file gets, so the editor says the drop
    // will land before it does
    this.view?.content.classList.add('nbe-filedrag');
  }

  private endVaultDrag(): void {
    this.view?.content.classList.remove('nbe-filedrag');
  }

  /**
   * A note, an image or a document dragged out of the file explorer.
   *
   * @remarks
   * The gap this closes is that Obsidian's sidebar is the vault's main way of
   * moving something into a note, and it spoke to the Markdown editor only:
   * dropping a note here did nothing at all. What lands is decided by
   * {@link blockFor} — a note becomes a link to it, anything else is embedded
   * at its vault path.
   *
   * The caret goes to the block under the pointer first, because
   * `insertBlocksAt` inserts *at the caret*: without this the note would take
   * the drop wherever the caret happened to be left, which for a drag that
   * started in another pane is nowhere near where it was let go.
   */
  private onVaultDrop(e: DragEvent): void {
    this.endVaultDrag();
    const files = this.draggedFiles();
    const view = this.view;
    const editor = this.editor;
    if (e.defaultPrevented || !files.length || !view || !editor) return;
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const anchorId =
      (under?.closest('.nbe-block') as HTMLElement | null)?.dataset['blockId'] ??
      getBlock(editor.doc, editor.doc.rootId).children.at(-1);
    if (!anchorId) return;
    editor.setSelection(textCaret(anchorId, textLength(getBlock(editor.doc, anchorId).text)), 'api');
    insertBlocksAt(view, files.map(blockFor), false);
  }

  /**
   * The rename has to survive the element being taken away.
   *
   * @remarks
   * The title committed on `blur`, and removing a focused element from the
   * document does not fire one — so typing a new name and then switching notes
   * (⌘O, the file explorer, a link) discarded the rename silently, which is
   * most of "you cannot always rename from the editor". Obsidian calls this
   * before it unloads the file — but *after* it has already assigned the new
   * one to `this.file`, which is why {@link commitTitle} renames
   * {@link titleFile} and not the view's current file.
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
    for (const url of this.pdfs.values()) void url.then((u) => u.startsWith('blob:') && URL.revokeObjectURL(u));
    this.pdfs.clear();
  }

  private inlineTitleEl: HTMLElement | null = null;

  /**
   * The file the inline title on screen belongs to.
   *
   * @remarks
   * **Not `this.file`.** Obsidian assigns the new file *before* it unloads the
   * old one, so by the time `onUnloadFile` — or a `blur` raised by the same
   * click — reaches {@link commitTitle}, `this.file` is already the note being
   * opened. The rename then landed on the wrong note, and when the name it was
   * being given was taken (by the note the title actually belonged to) it
   * failed with « Destination already exists ». The element and the file it was
   * built from travel together instead.
   */
  private titleFile: TFile | null = null;

  /**
   * The note's header: its cover, its icon and its title.
   *
   * @remarks
   * Built once per file and then *patched*: the cover, the icon and the « add »
   * row each own a slot that {@link renderHeader} rewrites, and the title
   * element is never one of them. Picking an icon must not replace the element
   * the caret is sitting in — a rename half typed would go with it.
   */
  private buildHeader(host: HTMLElement): void {
    const header = host.createDiv({ cls: 'carnet-header' });
    const cover = header.createDiv({ cls: 'carnet-coverslot' });
    const headline = header.createDiv({ cls: 'carnet-headline' });
    const actions = headline.createDiv({ cls: 'carnet-headeractions' });
    const row = headline.createDiv({ cls: 'carnet-titlerow' });
    const icon = row.createDiv({ cls: 'carnet-iconslot' });
    const title = row.createDiv({ cls: 'carnet-title' });
    this.headerSlots = { cover, icon, actions };
    this.inlineTitleEl = title;
    this.titleFile = this.file;
    title.textContent = this.displayTitle();
    this.renderHeader();
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
        title.textContent = this.displayTitle();
        title.blur();
      }
    });
    title.addEventListener('blur', () => void this.commitTitle());
  }

  /** The parts of the header a picker rewrites, kept apart from the title. */
  private headerSlots: { cover: HTMLElement; icon: HTMLElement; actions: HTMLElement } | null = null;

  /**
   * What the header carries for `icon` or `cover`.
   *
   * @remarks
   * A plain string: an emoji, a vault path, a URL. The wikilink spelling is
   * accepted on the way in because a header is a place people type in — and
   * `cover: "[[photo.png]]"` is how the rest of the vault writes a picture —
   * but it is not what we write, see {@link setHeaderValue}.
   */
  private headerValue(key: 'icon' | 'cover'): string {
    const raw = this.frontmatter.get(key);
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text.replace(/^!?\[\[(.*)\]\]$/, '$1').trim();
  }

  /**
   * Set the icon or the cover, and show it now.
   *
   * @remarks
   * A plain path rather than `[[…]]`: it is what the picker hands us, what
   * `getFirstLinkpathDest` resolves, and what stays readable in a header.
   *
   * ponytail: a plain path is not a link, so moving the picture in the file
   * explorer will not update it — Obsidian only rewrites what it recognises as
   * a link. Write the wikilink form here if that ever costs someone a cover.
   */
  private setHeaderValue(key: 'icon' | 'cover', value: string | undefined): void {
    this.frontmatter.set(key, value);
    this.requestSave();
    this.renderHeader();
  }

  /** Paint the cover, the icon and whichever of the two is still missing. */
  private renderHeader(): void {
    const slots = this.headerSlots;
    if (!slots) return;
    const path = this.file?.path ?? '';
    const icon = this.headerValue('icon');
    const cover = this.headerValue('cover');

    slots.icon.empty();
    if (icon) {
      const button = slots.icon.createEl('button', {
        cls: 'carnet-icon',
        attr: { type: 'button', 'aria-label': 'Changer l’icône' },
      });
      button.append(iconEl(this.app, icon, 'carnet-iconimg', path));
      button.addEventListener('click', () => this.pickIcon(button));
    }

    slots.cover.empty();
    if (cover) {
      const box = slots.cover.createDiv({ cls: 'carnet-cover' });
      // the vault's setting, in CSS units, because a cover is a band of page
      // and 300px is only the height that band happens to start at
      box.style.height = this.plugin.settings.coverHeight.trim() || '300px';
      box.createEl('img', { attr: { src: iconSrc(this.app, cover, path), alt: '' } });
      const bar = box.createDiv({ cls: 'carnet-coveractions' });
      const change = bar.createEl('button', {
        cls: 'carnet-headeraction',
        text: 'Changer la couverture',
        attr: { type: 'button' },
      });
      change.addEventListener('click', () => this.pickCover(change));
      const drop = bar.createEl('button', {
        cls: 'carnet-headeraction',
        text: 'Retirer',
        attr: { type: 'button' },
      });
      drop.addEventListener('click', () => this.setHeaderValue('cover', undefined));
    }

    /*
     * Add what is missing, remove what is there — and never « Ajouter une
     * icône » beside an icon, which is a button for something that already
     * happened. Changing is the icon itself, and the cover's own bar.
     */
    slots.actions.empty();
    const action = (label: string, run: (anchor: HTMLElement) => void) => {
      const button = slots.actions.createEl('button', {
        cls: 'carnet-headeraction',
        text: label,
        attr: { type: 'button' },
      });
      button.addEventListener('click', () => run(button));
    };
    if (icon) action('Retirer l’icône', () => this.setHeaderValue('icon', undefined));
    else action('Ajouter une icône', (a) => this.pickIcon(a));
    if (!cover) action('Ajouter une couverture', (a) => this.pickCover(a));
  }

  /** Emoji or image, the same picker the callout block uses. */
  private pickIcon(anchor: HTMLElement): void {
    const current = this.headerValue('icon');
    openIconPicker(() => anchor.getBoundingClientRect(), {
      // this picker is opened by the host, not by the editor, so nothing hands
      // it the catalogue or the dictionary — they are taken from the editor
      // beside it, which is where the vault's language already landed
      emojis: this.view?.options.emojis,
      labels: this.view?.labels,
      onPick: (icon) => this.setHeaderValue('icon', icon),
      // decoded on the way in: the header is read by people, and
      // `Pi%C3%A8ces%20jointes/x.png` is a path nobody typed
      storeImage: (file) => this.storeAttachment(file).then(decodePath),
      ...(current ? { current, onRemove: () => this.setHeaderValue('icon', undefined) } : {}),
    });
  }

  /** The same picker, without the emoji half: a cover is a picture. */
  private pickCover(anchor: HTMLElement): void {
    const current = this.headerValue('cover');
    openIconPicker(() => anchor.getBoundingClientRect(), {
      imageOnly: true,
      removeLabel: 'Retirer la couverture',
      labels: this.view?.labels,
      onPick: (src) => this.setHeaderValue('cover', src),
      storeImage: (file) => this.storeAttachment(file).then(decodePath),
      ...(current ? { current, onRemove: () => this.setHeaderValue('cover', undefined) } : {}),
    });
  }

  /**
   * Put the caret at the end of the title, the way ArrowUp should leave it —
   * or over the whole of it, so the first keystroke replaces « Untitled ».
   */
  private focusTitle(select = false): void {
    const title = this.inlineTitleEl;
    if (!title) return;
    title.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(title);
    if (!select) range.collapse(false);
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

  /**
   * Commit the edited title: the filename takes what it can hold, the
   * frontmatter keeps the rest.
   *
   * @remarks
   * The file is named through `slugify`, because a title is not a filename:
   * « Daily 10/08 » went to the vault verbatim and the slash was read as a
   * folder that does not exist, so renaming a note reported `ENOENT … Daily/
   * Daily 10/08.md` — a filesystem error for something the user did nothing
   * wrong to cause. It is the same reduction `@nbe/markdown` applies when it
   * writes `[[Titre]]`, and for the same reason: a vault names a note
   * `<Titre>.md` and links to it by that name.
   *
   * What is new is that the reduction is no longer the *title*. A `title:`
   * property carries what the author typed, so « Réunion : 2026/07 » is a note
   * called « Réunion : 2026/07 » in a file called `Réunion 2026 07.md` — and
   * the property is only written when the two actually differ, so renaming an
   * ordinary note still leaves an ordinary note.
   */
  private async commitTitle(): Promise<void> {
    const title = this.inlineTitleEl;
    const file = this.titleFile;
    if (!title || !file) return;
    const typed = (title.textContent ?? '').trim();
    const name = typed ? slugify(typed) : '';
    if (!name || typed === this.displayTitle(file)) {
      title.textContent = this.displayTitle(file);
      return;
    }
    if (this.frontmatter.get('title') !== (name === typed ? undefined : typed)) {
      this.frontmatter.set('title', name === typed ? undefined : typed);
      this.requestSave();
    }
    if (name !== file.basename) {
      const folder = file.parent?.path ?? '';
      try {
        // fileManager, not vault: this is the rename that updates backlinks
        await this.app.fileManager.renameFile(file, normalizePath(`${folder}/${name}.${file.extension}`));
      } catch (err) {
        new Notice(err instanceof Error ? err.message : String(err));
      }
    }
    title.textContent = this.displayTitle(file);
  }

  private build(markdown: string): void {
    if (!this.mount) return;
    /*
     * A genuine external change still rebuilds, and the reader still keeps
     * their place: the mount is the scroller, and emptying it clamps the
     * position to zero. Restored once the document is whole — a streamed
     * opening render only has a screenful in it at first, so a position
     * further down would clamp all over again.
     */
    const scroller = this.mount;
    const wasAt = scroller.scrollTop;
    this.loading = true;
    this.view?.destroy();
    this.mount.empty();
    // emptied with the mount, so the field must not outlive the element
    this.templateRow = null;

    const opts = viewOptions(this.plugin.settings);
    // the title supplies the top spacing; keep the editor close under it
    if (!this.plugin.settings.padTop.trim()) opts.padding = { ...opts.padding, top: '12px' };

    /*
     * The header comes off first: it is not prose, and everything under it —
     * the title, the discussion — is read from there rather than found in the
     * text. What we do not read is kept as it was written, and goes back out
     * that way on the next save.
     */
    const file = readFrontmatter(markdown);
    this.frontmatter = file.frontmatter;
    /*
     * The header is built *after* it, not before: the title, the icon and the
     * cover all come out of those keys, and building first meant drawing the
     * previous note's — a `title:` from the note you just left, on the note you
     * just opened, until something else redrew it.
     */
    this.buildHeader(this.mount);
    // the threads come out of the note before it is parsed as blocks; the
    // anchors stay in the text, where `applyAnchors` turns them into marks
    const note = this.plugin.settings.comments
      ? readComments(file.frontmatter, file.body)
      : { markdown: file.body, threads: [] };
    this.comments = this.plugin.settings.comments
      ? createNoteComments(note.threads, () => {
          if (!this.loading) this.requestSave();
          // a reply changes no mark, so the margin's number would stay behind
          if (this.view) refreshCommentMarkers(this.view);
        })
      : null;

    // the ids the note actually carries: an anchor naming anything else is a
    // badge that opens an empty panel, with no thread to delete to be rid of it
    this.editor = new Editor({
      doc: docFromJSON(pageOf(note.markdown, new Set(note.threads.map((t) => t.id)))),
    });
    this.view = new EditorView(this.mount, this.editor, {
      ...opts,
      // comments live in the note itself, so this host can offer them at all
      ...(this.comments
        ? {
            onComment: (blockId, author, at) => this.comments?.onComment(this.editor!, blockId, author, at),
            commentAuthor: { id: 'obsidian', name: 'Vous' },
            // messages, not threads: three comments in a row join one thread,
            // and "1" beside a panel showing three of them is a wrong number
            commentCount: (_blockId, threadIds) =>
              threadIds.reduce((n, id) => n + (this.comments?.store.get(id)?.messages.length ?? 0), 0),
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
      /*
       * The slash menu's « Page » entry, which was inert here: without this
       * hook the editor does not render it at all, so the one block that
       * *makes* a note could not be reached from inside a note.
       *
       * The note is created for real, beside the one being edited, rather than
       * left as an unresolved link — "add a page" that adds nothing is a
       * different feature. The hook is synchronous and `vault.create` is not,
       * so the name is settled here (which is the part the block stores) and
       * the file follows. `link_to_page` is written as `[[Nom]]`, which is
       * already how a vault spells this, so the block round-trips natively.
       */
      onCreatePage: () => this.createNote(),
      // a pasted or dropped image is an attachment, and the vault already has
      // a policy for where those go — so we ask it rather than invent a folder
      onStoreAsset: (blob) => this.storeAttachment(blob),
      resolveAssetUrl: (src) => this.resolveAttachment(src),
      onResolveLink: (url) => resolveTitle(url),
    });
    /*
     * `requestSave` is Obsidian's debounced writer, and letting it own the
     * timing is the point: it already knows about conflicts, external changes
     * and shutdown, and a second save policy beside it would be a way to lose
     * an edit rather than a way to be faster.
     */
    this.editor.on(() => {
      if (this.loading) return;
      // someone who started writing has answered the question
      this.templateRow?.remove();
      this.templateRow = null;
      this.requestSave();
      this.recount();
    });
    this.loading = false;
    /*
     * A note *just created* needs a name, so the title takes the focus,
     * selected, exactly as Obsidian's own inline title does on « Nouvelle
     * note ». Opening a note — any note — is reading, and reading must not
     * steal the caret: an empty note alone was the wrong test, because a vault
     * is full of empty notes and every one of them grabbed the focus and
     * offered its name up for overwriting on a plain click in the sidebar.
     *
     * ponytail: "just created" is the file's age, because Obsidian gives a
     * view no other way to know — the same note opened again a minute later is
     * simply a note. Two seconds covers create-then-open on a slow vault; a
     * miss costs the nicety and nothing else.
     */
    if (this.file && !markdown.trim() && Date.now() - this.file.stat.ctime < 2000) {
      this.focusTitle(true);
      /*
       * …and the same moment is the only one where offering a template makes
       * sense: a note with anything in it is a note being edited, and pushing
       * a row of buttons under its title would be an interruption. The caret
       * stays in the title throughout — `renderTemplateChoice` explains why
       * that rules out a menu.
       */
      this.templateRow = renderTemplateChoice(
        this.inlineTitleEl,
        this.plugin,
        this.file.parent?.path ?? '',
        (text) => this.applyTemplate(text),
      );
    }
    void this.view.whenComplete().then(() => {
      if (wasAt) scroller.scrollTop = wasAt;
      // a search result opens the file *then* says where to go, and either
      // order can win the race — so the landing is tried from both ends
      this.revealPending();
    });
  }

  /** « Commencer avec un modèle », while the new note is still empty. */
  private templateRow: HTMLElement | null = null;

  /**
   * Start this note from a template.
   *
   * @remarks
   * A full rebuild rather than an insertion, because the template is a whole
   * file — its header as well as its blocks — and the note it is landing in is
   * empty, so there is nothing to merge and nothing to lose. `requestSave` is
   * explicit here for the one reason it usually is not: {@link build} loads
   * with `loading` set, which is exactly what stops a mount from marking the
   * file dirty, so the write has to be asked for on the other side of it.
   *
   * The title is focused again for the same reason it was a moment ago — the
   * note still has no name, and now it has everything else.
   */
  private applyTemplate(markdown: string): void {
    this.data = markdown;
    this.build(markdown);
    this.requestSave();
    this.focusTitle(true);
  }

  /**
   * A new, empty note beside this one, named so it collides with nothing.
   *
   * @remarks
   * The name is what the block stores and what the wikilink resolves by, so it
   * has to be decided *now* — `vault.create` is asynchronous and the editor's
   * hook is not. The uniqueness check and the create are therefore two steps,
   * which is a race in theory: two notes made in the same millisecond. The
   * create is the one that would fail, and it says so rather than overwriting.
   */
  private createNote(): { pageId: string; title: string } | null {
    const folder = this.file?.parent?.path ?? '';
    const path = (name: string) => normalizePath(`${folder}/${name}.md`);
    const base = 'Nouvelle note';
    let name = base;
    for (let n = 2; this.app.vault.getAbstractFileByPath(path(name)); n++) name = `${base} ${n}`;
    void this.app.vault
      .create(path(name), '')
      .catch((err) => new Notice(err instanceof Error ? err.message : String(err)));
    return { pageId: name, title: name };
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
   * `![[x.png]]` reaches here too now: `@nbe/markdown` reads Obsidian's embed
   * syntax as an image whose `src` is the raw target, which is exactly what
   * `getFirstLinkpathDest` resolves — and writes it back as `![[x.png]]`, so
   * opening a vault full of them leaves no diff.
   */
  private resolveAttachment(src: string): string | Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http(s), data:, already resolved
    const file = this.app.metadataCache.getFirstLinkpathDest(decodeURI(src), this.file?.path ?? '');
    if (!file) return src;
    return file.extension === 'pdf' ? this.pdfUrl(file) : this.app.vault.getResourcePath(file);
  }

  /** Blob URLs handed to the PDF viewer, revoked with the view. */
  private readonly pdfs = new Map<string, Promise<string>>();

  /**
   * A PDF as bytes, not as an `app://` URL.
   *
   * @remarks
   * **This is a crash, not an optimisation.** Obsidian filters every `app://`
   * request in its main process and the filter reads `details.frame.origin`
   * unconditionally — and Chromium's PDF viewer issues its request with no
   * frame attached, so `frame` is `undefined` and the *main process* throws:
   * "A JavaScript error occurred in the main process… reading 'origin'". A
   * modal, on every note holding a PDF, before a byte is rendered. (Dismissing
   * it lets the load through, which is how it looked like a slow preview.)
   *
   * The vault will hand us the bytes without going through the scheme at all,
   * so it does. Cached per path, because a re-render must not read a 20MB file
   * again, and revoked in {@link onClose} — an object URL is a leak until it
   * is.
   *
   * ponytail: the whole file, in memory, for as long as the note is open —
   * which is what Obsidian's own viewer does too. Range requests would need a
   * viewer of our own.
   */
  private pdfUrl(file: TFile): Promise<string> {
    const known = this.pdfs.get(file.path);
    if (known) return known;
    const url = this.app.vault
      .readBinary(file)
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })))
      // the raw path is what it got before this existed: no preview, no crash
      .catch(() => this.app.vault.getResourcePath(file));
    this.pdfs.set(file.path, url);
    return url;
  }

  /** Rebuild with the current settings, keeping the document being edited. */
  refresh(): void {
    this.build(this.getViewData());
  }

  /** The blocks a command should act on: the caret's, or the selection's. */
  targets(): BlockId[] {
    const sel = this.editor?.selection;
    if (!sel) return [];
    if (sel.kind === 'block') return selectedBlocks(this.editor!.doc, sel);
    return sel.kind === 'text' ? [sel.head.blockId] : [];
  }

  /** The model and its projection, for a host command. */
  parts(): { editor: Editor; view: EditorView } | null {
    return this.editor && this.view ? { editor: this.editor, view: this.view } : null;
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
