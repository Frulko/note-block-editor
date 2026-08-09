import type { BlockId, Change, Editor, Point, Selection } from '@nbe/core';
import { ancestors, getBlock, selectedBlocks, textCaret } from '@nbe/core';
import { renderBlock } from './render';
import { leafOf, modelPointToDom } from './selection';
import { reconcileLeaf } from './input';
import { plainText } from '@nbe/core';
import { domTextSelection } from './caret';
import { perBlockTopology, type EditableTopology } from './topology';
import { reveal } from './viewport';
import type { ActiveGesture, GestureRecognizer } from './gestures';
import type { GutterItem } from './controls';

import { defaultRecognizers } from './recognizers';
import { defaultFeatures, type EditorFeature } from './features';
import { resolveLabels, type EditorLabels } from './labels';
import { builtinBlocks } from './blocks';
import { injectBlockStyles, viewOf, type DomBlockPlugin } from './block-view';
import { PluginRegistry } from '@nbe/core';

/**
 * A person, for display beside what they said.
 *
 * @category Configuration
 */
export interface CommentAuthor {
  /** Stable across sessions; what the host stores on the thread. */
  id: string;
  /** What to show. */
  name: string;
  /** A URL or data URI. Display only — the editor never fetches it. */
  avatar?: string;
}

/**
 * Everything a host can change when mounting an editor.
 *
 * @remarks
 * Three principles govern this surface: what you do not import is not in your
 * bundle, an array's order *is* its precedence, and nothing is privileged —
 * every default is a plain array literal you can copy and edit.
 *
 * @category Configuration
 */
export interface EditorViewOptions {
  /** Follow a page link. The editor never routes; the host decides. */
  onOpenPage?: (pageId: string) => void;
  /**
   * Candidates for the `@` mention picker.
   *
   * @remarks
   * Without it the `@` trigger stays inert, because an autocomplete with
   * nothing to complete is worse than no autocomplete.
   *
   * @param query - What the user has typed after the `@`.
   */
  onSearchPages?: (query: string) => Array<{ pageId: string; title: string; icon?: string }>;
  /**
   * The current title of a mentioned page.
   *
   * @remarks
   * Called at render time so a rename propagates to every mention. Return
   * `null` for a page that no longer exists — the mention then shows its
   * stored text, marked as unresolved, instead of disappearing.
   */
  resolvePageTitle?: (pageId: string) => string | null;
  /** Create a page in the host workspace (slash menu "Page" item). */
  onCreatePage?: () => { pageId: string; title: string } | null;
  /**
   * Open a comment on a block, from the button in the right-hand gutter.
   *
   * @remarks
   * **A comment is on a block**, never on a hand-picked range. That is why it
   * hangs off the gutter rather than the selection toolbar, and it is what
   * makes the affordance discoverable: hovering a block shows everything you
   * can do to it, and one of those things is discuss it.
   *
   * The threads themselves are the host's: `@nbe/core` has the model and
   * `@nbe/collab` puts it in the CRDT, but *where a discussion is displayed* is
   * a layout decision the editor cannot make — a sidebar, a popover, a panel in
   * another pane. So the editor contributes the affordance and nothing else,
   * and without this host the button is not rendered at all rather than
   * rendered dead.
   *
   * @param blockId - The block the pointer was on.
   * @param author - `commentAuthor`, or `null` when nobody was named.
   */
  onComment?: (blockId: BlockId, author: CommentAuthor | null) => void;
  /**
   * Who is commenting.
   *
   * @remarks
   * Absent, comments are anonymous — which is a real mode, not a degraded one:
   * a shared machine, a kiosk, a review link with no login. The editor never
   * invents an identity to fill the gap, it passes `null` and lets the host
   * decide what "anonymous" looks like.
   *
   * The editor does not persist this. It hands it to `onComment` and the host
   * stores `id` and `name` on the thread; `avatar` is display only.
   */
  commentAuthor?: CommentAuthor;
  /**
   * What the two hover gutters contain.
   *
   * @remarks
   * Both sides are lists you can add to, reorder, or empty — see
   * {@link GutterItem}. The defaults are `['add', 'handle']` on the left and
   * `['comment']` on the right.
   *
   * @example
   * ```ts
   * import { defaultLeftGutter } from '@nbe/dom'
   * new EditorView(el, editor, {
   *   gutter: {
   *     left: defaultLeftGutter,
   *     right: [
   *       'comment',
   *       { name: 'approve', icon: 'check', title: 'Valider', onClick: (id) => approve(id) },
   *     ],
   *   },
   * })
   * ```
   */
  gutter?: { left?: readonly GutterItem[]; right?: readonly GutterItem[] };
  /**
   * Store a pasted/dropped binary and return the opaque src to persist
   * (convention: `asset:<content-hash>`). Without it, file paste/drop is ignored.
   */
  onStoreAsset?: (blob: Blob) => Promise<string>;
  /** Resolve a persisted src (asset:… or URL) to something an <img> can load. */
  resolveAssetUrl?: (src: string) => string | Promise<string>;
  /** Collections/views/row-pages live in the host workspace (phase 3, §2.5). */
  database?: import('./database').DatabaseHost;
  /**
   * Page geometry owned by the editor, not by the host app. The editor fills
   * its container and centers the text column inside `maxWidth`; everything
   * outside the column but inside the padding is still editor surface, so
   * rubber-band selection and click-to-place work there (Word-like margins).
   * Set any value to 0 / '0px' for a flush-to-the-edge look.
   */
  padding?: { top?: string; bottom?: string; x?: string };
  /** Text column width; '100%' disables centering. Default 708px (Notion). */
  maxWidth?: string;
  /**
   * Where the editable boundary sits. Defaults to one host per block (D1);
   * `singleHostTopology` puts it on the root instead. Every interaction module
   * is written against this, so switching is a config change.
   */
  topology?: EditableTopology;
  /**
   * Pointer gestures, in precedence order — the arbitration story as data.
   * Defaults to text selection, block click-routing and the rubber band.
   * Replace it to add a gesture, reorder it to change who wins a contested
   * press, or pass `[]` for an editor that handles none.
   */
  recognizers?: GestureRecognizer[];
  /**
   * Block plugins, replacing the closed dispatches. Defaults to the built-in
   * set; not importing a plugin keeps it out of the bundle, which is the point
   * of activation-by-import.
   */
  blocks?: DomBlockPlugin[];
  /**
   * Behaviour attached to the mounted view, in registration order.
   *
   * @remarks
   * Defaults to {@link defaultFeatures}. Pass {@link minimalFeatures} for a
   * comment box, `[]` for a viewer, or a filtered copy to drop one thing.
   * What you leave out is not in your bundle.
   *
   * @example
   * ```ts
   * features: defaultFeatures.filter((f) => f.name !== 'slash-menu')
   * ```
   */
  features?: EditorFeature[];
  /**
   * Render the document without making it editable.
   *
   * @remarks
   * Drops `contenteditable` and the tab stop, so no caret ever appears — which
   * is the difference between a viewer and an editor that silently ignores
   * keystrokes. Combine with `features: []` to attach nothing at all.
   *
   * @defaultValue false
   */
  readOnly?: boolean;
  /**
   * **Experimental.** Whether dropping a block beside another creates a column.
   *
   * @remarks
   * Off by default, and the default is the interesting part. Columns are
   * ordinary nested blocks (§2.3), so this flag governs only the *gesture* — a
   * document that already has columns still renders and still reorders, and
   * columns stay reachable from the slash menu either way.
   *
   * What the default buys is a drag with one meaning. Two answers to the same
   * gesture is what made dragging feel unreliable: aiming for "move below" and
   * getting a two-column layout is not a near miss, it is a different document,
   * and the side bands have to be tuned rather than merely correct. Until that
   * is settled, a drag reorders — vertically, always — and side-by-side layout
   * is something you ask for explicitly.
   *
   * @defaultValue false
   *
   * @example
   * ```ts
   * new EditorView(el, editor, { columns: true })
   * ```
   */
  columns?: boolean;
  /**
   * Ask the browser to spell-check the editable surface.
   *
   * @defaultValue false
   */
  spellcheck?: boolean;
  /**
   * Every string the editor puts on screen. Merged over the French defaults,
   * so a partial dictionary is fine.
   */
  labels?: Partial<EditorLabels>;
  /**
   * CSS custom properties set on the editor root, overriding the token layer.
   *
   * @remarks
   * The stylesheet resolves every colour from about a dozen base channels
   * plus the named block palette, so a theme is a handful of values rather
   * than a rule override. Keys may be written with or without the `--` prefix.
   *
   * @example
   * ```ts
   * theme: { '--nbe-accent-rgb': '220 38 38', '--nbe-radius': '2px' }
   * ```
   */
  theme?: Record<string, string>;
}

/**
 * A document, projected into the DOM, and everything that makes editing it
 * feel like an editor.
 *
 * @remarks
 * The view owns the element it creates and nothing else: it appends a
 * `.nbe-editor` div to the container you give it, renders the document into it,
 * attaches the {@link EditorFeature}s you asked for, and unbinds all of it on
 * {@link EditorView.destroy}. **The DOM is a projection, never the source of
 * truth** — the model is in {@link Editor}, and a view can be thrown away and
 * rebuilt without the document noticing.
 *
 * The content is *uncontrolled*. Re-mounting on every render would destroy the
 * caret, the selection and the undo stack, so the initial document is read once
 * and the editor owns it from then on; a host observes with `editor.on(…)`.
 *
 * @example The whole of a minimal integration
 * ```ts
 * import { Editor, createDoc } from '@nbe/core'
 * import { EditorView } from '@nbe/dom'
 * import '@nbe/dom/style.css'
 *
 * const editor = new Editor({ doc: createDoc() })
 * const view = new EditorView(document.getElementById('app')!, editor)
 * // …later
 * view.destroy()
 * ```
 *
 * @category Rendering
 */
export class EditorView {
  /** The model this view projects. */
  readonly editor: Editor;
  /** The `.nbe-editor` element this view created and owns. */
  readonly content: HTMLElement;
  /** The options it was mounted with, verbatim. */
  readonly options: EditorViewOptions;
  /** Where the editable boundary sits: one host per block, or one at the root. */
  readonly topology: EditableTopology;
  private _composing = false;
  /** A full re-render that arrived mid-composition and is owed. */
  private renderOwed = false;

  /**
   * True while an IME is composing.
   *
   * @remarks
   * A setter rather than a field, so that clearing it can pay back a render
   * that arrived while it was set. §5.1's rule is usually stated as "never
   * mutate the DOM mid-composition", and the paths that *write* have always
   * honoured it — but a **remote** edit reaches `renderAll` from outside the
   * input path entirely, and would rebuild the surface under a half-typed
   * word. Deferring is the whole fix: the update is not dropped, it lands the
   * moment the word is committed.
   */
  get composing(): boolean {
    return this._composing;
  }

  set composing(value: boolean) {
    this._composing = value;
    if (!value && this.renderOwed) {
      this.renderOwed = false;
      this.renderAll();
    }
  }
  /**
   * What pointer gesture is running, published by the gesture router. This is
   * the state that replaced three wall-clock windows: modules ask what is
   * happening instead of guessing from how long ago something happened.
   */
  gesture: ActiveGesture | null = null;
  /**
   * Pointer gestures in precedence order. Features contribute to this list —
   * `unshift` to outrank the defaults — and the router reads it at press time,
   * so who wins a contested press is data rather than attach order.
   */
  readonly recognizers: GestureRecognizer[];
  /** Per-editor, never module-global: two editors may have different sets. */
  readonly plugins: PluginRegistry;
  /** Resolved on-screen strings: the defaults with `options.labels` merged in. */
  readonly labels: EditorLabels;
  /** True when the view was mounted read-only. */
  readonly readOnly: boolean;
  /** Notified once a pointer gesture has fully settled. See `onGestureEnd`. */
  readonly gestureEndListeners = new Set<(name: string, committed: boolean) => void>();
  /**
   * Where the caret last was in text. Opening a menu or selecting a block
   * replaces the live selection, so anything that needs to act "where the user
   * was typing" — table row/column actions, for one — reads this instead.
   */
  lastTextCaret: Point | null = null;

  private unbinders: Array<() => void> = [];

  /**
   * @param container - The view appends its own element here. The container is
   * not emptied and not otherwise touched.
   * @param editor - The model. Several views may project the same one.
   * @param options - See {@link EditorViewOptions}. Everything is optional; the
   * defaults are a full editor.
   */
  constructor(container: HTMLElement, editor: Editor, options: EditorViewOptions = {}) {
    this.editor = editor;
    this.options = options;
    this.topology = options.topology ?? perBlockTopology;
    this.recognizers = [...(options.recognizers ?? defaultRecognizers)];
    this.plugins = new PluginRegistry().registerAll(options.blocks ?? builtinBlocks);
    /*
     * Mounting a view registers its blocks on the model too, so `blocks: [...]`
     * stays the single activation point: the schema learns the types and the
     * document invariants (`plugin.normalize`) run on every transaction, view
     * or no view. Idempotent by type — a headless host that already passed
     * them to `new Editor({ plugins })` registers them once.
     */
    for (const plugin of this.plugins.all()) editor.use(plugin);
    this.labels = resolveLabels(options.labels);
    this.readOnly = options.readOnly === true;
    for (const plugin of this.plugins.all()) {
      const styles = viewOf(plugin)?.styles;
      if (styles) injectBlockStyles(plugin.schema.type, styles);
    }
    this.content = document.createElement('div');
    this.content.className = 'nbe-editor';
    if (options.padding?.top !== undefined) this.content.style.setProperty('--nbe-pad-top', options.padding.top);
    if (options.padding?.bottom !== undefined)
      this.content.style.setProperty('--nbe-pad-bottom', options.padding.bottom);
    if (options.padding?.x !== undefined) this.content.style.setProperty('--nbe-pad-x', options.padding.x);
    if (options.maxWidth !== undefined) this.content.style.setProperty('--nbe-max-width', options.maxWidth);
    this.content.tabIndex = 0; // the document's single tab stop (ARCHITECTURE §8)
    this.content.setAttribute('role', 'textbox');
    this.content.setAttribute('aria-multiline', 'true');
    this.content.dataset['topology'] = this.topology.name;
    this.content.spellcheck = options.spellcheck === true;
    if (this.readOnly) {
      this.content.dataset['readonly'] = '';
      this.content.removeAttribute('tabindex');
      this.content.removeAttribute('contenteditable');
    } else {
      this.topology.prepareRoot(this.content);
    }
    for (const [key, value] of Object.entries(options.theme ?? {})) {
      this.content.style.setProperty(key.startsWith('--') ? key : `--${key}`, value);
    }
    container.append(this.content);

    this.renderAll();
    // features are data: what a host leaves out is not attached and not bundled
    for (const f of options.features ?? (this.readOnly ? [] : defaultFeatures)) {
      this.unbinders.push(f.attach(this));
    }
    // a block plugin's own features, after the editor's: a table's cell
    // selection contributes a recognizer, and precedence is registration order
    if (!this.readOnly)
      for (const plugin of this.plugins.all())
        for (const f of viewOf(plugin)?.features ?? []) this.unbinders.push(f.attach(this));
    this.unbinders.push(editor.on((change) => this.handleChange(change)));
    this.unbinders.push(editor.onSelection((sel, origin) => this.renderSelection(sel, origin)));

    // extension defense (ARCHITECTURE §5.1): DOM mutations that didn't come
    // from our reconciler are either merged into the model (text) or reverted
    this.observer = new MutationObserver((muts) => this.onForeignMutations(muts));
    this.observe();
    this.unbinders.push(() => this.observer?.disconnect());
  }

  private observer: MutationObserver | null = null;

  private observe(): void {
    this.observer?.observe(this.content, { subtree: true, childList: true, characterData: true });
  }

  /** All our own DOM writes go through this so the observer only sees foreign mutations. */
  private withObserverPaused<T>(fn: () => T): T {
    this.observer?.disconnect();
    try {
      return fn();
    } finally {
      this.observe();
    }
  }

  private onForeignMutations(muts: MutationRecord[]): void {
    if (this.composing) return; // never touch the DOM mid-composition
    const doc = this.editor.doc;
    const leaves = new Set<HTMLElement>();
    for (const m of muts) {
      const leaf = leafOf(m.target);
      if (leaf) {
        leaves.add(leaf);
        continue;
      }
      // foreign nodes injected between blocks (extension toolbars, overlays):
      // remove them; our own structural renders never run while observing
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement && !n.className.toString().startsWith('nbe-')) {
            this.withObserverPaused(() => n.remove());
          }
        }
      }
    }
    for (const leaf of leaves) {
      const id = leaf.dataset['blockId'];
      if (!id || !doc.blocks.has(id)) continue;
      const modelText = plainText(getBlock(doc, id).text);
      if ((leaf.textContent ?? '') !== modelText) {
        // text changed outside our pipeline (Grammarly accept, autofill…):
        // treat it as user intent and diff it into the model
        reconcileLeaf(this, leaf);
      } else {
        // same text but foreign markup (highlight spans, style attributes):
        // the model re-render is the canonical cleanup
        this.withObserverPaused(() => {
          const current = this.blockEl(id);
          if (current?.isConnected) current.replaceWith(renderBlock(this, id));
        });
        this.syncDomSelection();
      }
    }
  }

  /**
   * Detach every feature, stop listening to the editor, and remove the element.
   *
   * @remarks
   * The document survives: `destroy()` disposes of a *projection*. Call it when
   * the host unmounts, or the feature listeners outlive the page they were for.
   */
  destroy(): void {
    for (const un of this.unbinders) un();
    this.content.remove();
  }

  /** Run `cb` after every pointer gesture settles. Returns an unsubscribe. */
  /**
   * Called once a pointer gesture has fully settled.
   *
   * @returns An unsubscribe.
   */
  onGestureEnd(cb: (name: string, committed: boolean) => void): () => void {
    this.gestureEndListeners.add(cb);
    return () => this.gestureEndListeners.delete(cb);
  }

  /** The element rendering a block, or `null` if it is not on screen. */
  blockEl(id: string): HTMLElement | null {
    return this.content.querySelector(`.nbe-block[data-block-id="${CSS.escape(id)}"]`);
  }

  /** The editable leaf inside a block, where its text lives. */
  leafEl(id: string): HTMLElement | null {
    return this.content.querySelector(`.nbe-leaf[data-block-id="${CSS.escape(id)}"]`);
  }

  /**
   * Rebuild the whole surface from the document.
   *
   * @remarks
   * The escape hatch for a change the view did not see — a remote edit landing
   * straight in the store, or a document swapped underneath. Ordinary edits do
   * not need it: `dispatch` repaints only what it touched. Deferred while an
   * IME is composing, and paid back the moment the word is committed.
   */
  renderAll(): void {
    // a remote edit must not rebuild the surface under a half-typed word; the
    // setter above pays this back the moment composition ends
    if (this._composing) {
      this.renderOwed = true;
      return;
    }
    const root = getBlock(this.editor.doc, this.editor.doc.rootId);
    this.withObserverPaused(() =>
      this.content.replaceChildren(...root.children.map((id) => renderBlock(this, id))),
    );
  }

  private handleChange(change: Change): void {
    const doc = this.editor.doc;
    // DOM-truth snapshot: re-renders destroy the live caret; if the
    // transaction didn't move the selection we put the caret back where the
    // user visibly had it
    const caretBefore = domTextSelection(this);
    /*
     * A table's column template is an inline style on the *table*, computed
     * from the cells of its rows. Inserting or deleting a column only dirties
     * the rows, so re-rendering just them left the table laid out for the old
     * column count and the extra cells wrapped onto a new grid line. Typing in
     * a cell dirties the cell, not the row, so this does not re-render the
     * whole table on every keystroke.
     */
    const alive = [...change.dirty]
      .filter((id) => doc.blocks.has(id))
      .map((id) => {
        const block = doc.blocks.get(id)!;
        return block.type === 'table_row' && block.parentId ? block.parentId : id;
      });
    const set = new Set(alive);
    // skip ids whose ancestor is also dirty — the ancestor re-render covers them
    const roots = [...set].filter((id) => !ancestors(doc, id).some((p) => set.has(p)));
    for (const id of roots) {
      if (id === doc.rootId) {
        this.renderAll();
      } else {
        /*
         * Looked up *inside* the paused block, not before it. Another writer —
         * a database view re-rendering itself on a host change — can replace
         * the same element for the same edit, and a node captured a moment
         * earlier is then detached: `replaceWith` throws `NotFoundError`, once
         * per edit. Found by `e2e/database.spec.ts`.
         */
        this.withObserverPaused(() => {
          const old = this.blockEl(id);
          if (old?.isConnected) old.replaceWith(renderBlock(this, id));
          else this.renderAll(); // lost track — a full re-render is always correct
        });
      }
    }
    // only re-assert the DOM caret when the transaction moved the selection —
    // ui/programmatic changes must never yank the caret from where the user put it
    if (change.origin !== 'dom' && change.selectionSet) {
      this.syncDomSelection();
    } else if (caretBefore && !domTextSelection(this)) {
      // the re-render destroyed the caret: restore the pre-render DOM truth
      this.editor.setSelection(caretBefore, 'dom');
      this.syncDomSelection();
    }
    this.renderSelection(this.editor.selection, 'render');
  }

  /** Render block-selection overlays; text selection is native. */
  private renderSelection(sel: Selection, origin: string): void {
    if (sel?.kind === 'text') this.lastTextCaret = sel.head;
    const isBlock = sel?.kind === 'block';
    this.content.classList.toggle('nbe-blocksel', isBlock);
    for (const n of this.content.querySelectorAll('.nbe-selected')) n.classList.remove('nbe-selected');
    if (!isBlock) return;
    for (const id of selectedBlocks(this.editor.doc, sel)) {
      this.blockEl(id)?.classList.add('nbe-selected');
    }
    // keyboard-driven block selection owns focus; a live mouse drag keeps its native selection
    if (origin !== 'dom' && origin !== 'render') {
      document.getSelection()?.removeAllRanges();
      // only take focus if it is outside the editor: focusing the root while a
      // leaf holds it can make the browser drop a caret, which then reads as
      // an intent to leave block mode
      if (!this.content.contains(document.activeElement)) this.content.focus({ preventScroll: true });
      const head = this.blockEl(sel.head);
      if (head) reveal(head);
    }
  }

  /** Push the model selection into the browser (after re-renders and focus moves). */
  /**
   * Push the model's selection into the browser, after changing it in code.
   *
   * @remarks
   * Needed only when a host moves the caret itself; every edit that goes
   * through `dispatch` already does this.
   */
  syncDomSelection(): void {
    const sel = this.editor.selection;
    if (sel?.kind !== 'text') return;
    const anchor = modelPointToDom(this, sel.anchor);
    const head = modelPointToDom(this, sel.head);
    if (!anchor || !head) return;
    const leaf = this.leafEl(sel.head.blockId);
    // focusing a leaf makes it the editing host, which re-clamps the range to
    // it — fatal for a cross-block range, so only focus within a single block
    if (sel.anchor.blockId === sel.head.blockId) leaf?.focus({ preventScroll: true });
    try {
      document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    } catch {
      /* nodes replaced by a concurrent render; the next commit re-syncs */
    }
    if (leaf) reveal(leaf);
  }

  /** Move the caret to a block (used by keyboard navigation). */
  /** Put the caret in a block, at a character offset, and focus it. */
  focusBlock(id: string, offset: number): void {
    this.editor.setSelection(textCaret(id, offset));
    this.syncDomSelection();
  }

  private announcer: HTMLElement | null = null;

  /** Screen-reader announcement (polite live region, ARCHITECTURE §8). */
  /**
   * Say something in the live region, for screen readers.
   *
   * @remarks
   * For changes a sighted user sees happen and a blind one otherwise would not
   * — a block moved by drag, a column layout created.
   */
  announce(message: string): void {
    if (!this.announcer) {
      this.announcer = document.createElement('div');
      this.announcer.className = 'nbe-announcer';
      this.announcer.setAttribute('aria-live', 'polite');
      this.content.after(this.announcer);
    }
    this.announcer.textContent = '';
    requestAnimationFrame(() => {
      if (this.announcer) this.announcer.textContent = message;
    });
  }
}
