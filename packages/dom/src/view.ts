import type { BlockId, Change, Editor, Point, Selection } from '@nbe/core';
import { ancestors, getBlock, selectedBlocks, textCaret } from '@nbe/core';
import { renderBlock } from './render';
import { leafOf, modelPointToDom } from './selection';
import { reconcileLeaf } from './input';
import { plainText } from '@nbe/core';
import { domTextSelection } from './caret';
import { leafText, perBlockTopology, type EditableTopology } from './topology';
import { holdScroll, reveal } from './viewport';
import type { ActiveGesture, GestureRecognizer } from './gestures';
import type { GutterItem } from './controls';

import { defaultRecognizers } from './recognizers';
import { defaultFeatures, type EditorFeature } from './features';
import { resolveLabels, type EditorLabels } from './labels';
import { builtinBlocks } from './blocks';
import { injectBlockStyles, viewOf, type DomBlockPlugin } from './block-view';
import { PluginRegistry } from '@nbe/core';

/**
 * Where chrome that is not a block may live. See {@link EditorView.slot}.
 *
 * @category Rendering
 */
export type SlotName = 'top' | 'bottom' | 'floating';

/**
 * Blocks built before the first paint of a freshly mounted document.
 *
 * @remarks
 * More than a tall screenful, so nobody ever sees the seam, and small enough
 * that the first frame is cheap. See {@link EditorView.renderProgressively}.
 */
const FIRST_PAINT = 60;

/** How many more per frame after that. */
const TAIL_BATCH = 400;

/**
 * Put `node` before `ref` inside `host`, keeping it alive where the browser
 * can.
 *
 * @remarks
 * `moveBefore` is an *atomic* move: the node never leaves the document, so an
 * `<iframe>` keeps the page it was showing, a `<video>` keeps playing and
 * focus stays where it was. `insertBefore` is a remove followed by an insert,
 * and that reloads every frame it touches — which is what reordering a block
 * used to do to every embed on the page.
 *
 * Chromium 133 and up. Anywhere else this is exactly the behaviour that was
 * there before, not a new one.
 */
function moveInto(host: Element, node: Element, ref: Node | null): void {
  const move = (host as { moveBefore?: (n: Node, r: Node | null) => void }).moveBefore;
  if (move && node.isConnected && host.isConnected) {
    try {
      move.call(host, node, ref);
      return;
    } catch {
      /* a node it refuses — another document, a ref that is not a child */
    }
  }
  host.insertBefore(node, ref);
}

/**
 * Swap a block's element for a freshly rendered one, carrying the live nodes
 * across.
 *
 * @remarks
 * A rebuild is a new element tree, and a new `<iframe>` in it is a *new frame*:
 * it reloads, and whatever it was showing — a video part-way through, a form
 * half filled in — is gone. Sizing an embed is a prop change like any other,
 * so the drag ended by restarting the video it had just been sized around.
 *
 * A node the renderer marked `data-nbe-live` is moved from the old tree into
 * the new one instead, matched on the key in that attribute — its source, so a
 * *different* source is correctly a different node and does load. The new
 * node's attributes are copied onto the survivor, which is where the new
 * width, height and ratio are, and the new node is dropped. `src` and `srcdoc`
 * are never copied: they are the key, they cannot differ, and writing one
 * again is itself a reload.
 *
 * The old element stays in the document while this runs, because `moveBefore`
 * refuses to move a node that would leave it.
 */
function replaceBlockEl(old: HTMLElement, next: HTMLElement): void {
  old.after(next);
  const alive = new Map<string, HTMLElement>();
  for (const el of old.querySelectorAll<HTMLElement>('[data-nbe-live]')) alive.set(el.dataset['nbeLive'] ?? '', el);
  for (const to of alive.size ? next.querySelectorAll<HTMLElement>('[data-nbe-live]') : []) {
    const from = alive.get(to.dataset['nbeLive'] ?? '');
    if (!from || !to.parentElement) continue;
    // `data` is an `<object>`'s source; the same rule and the same reason
    const isKey = (name: string) => name === 'src' || name === 'srcdoc' || name === 'data';
    for (const a of [...from.attributes]) if (!to.hasAttribute(a.name) && !isKey(a.name)) from.removeAttribute(a.name);
    for (const a of to.attributes) if (!isKey(a.name)) from.setAttribute(a.name, a.value);
    moveInto(to.parentElement, from, to);
    to.remove();
  }
  old.remove();
}

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
 * What a comment affordance was pointing at.
 *
 * @remarks
 * Both fields absent is the original meaning and still the default: the whole
 * block. They are never both set — a click on an existing highlight already
 * has its thread, and a fresh selection does not have one yet.
 *
 * @category Comments
 */
export interface CommentContext {
  /**
   * Character offsets in the block, for a thread that does not exist yet.
   * Where the yellow highlight will go when the first message is sent.
   */
  range?: { from: number; to: number };
  /** The thread whose highlight was clicked. Show that one, not the block's. */
  threadId?: string;
  /**
   * Where the affordance was, so the panel opens beside it.
   *
   * @remarks
   * The panel used to hang off the *block*, which is right for nothing: the
   * button that opens it is a 26px bubble in the right margin, and a panel that
   * appears at the bottom-left corner of a six-line paragraph has visibly
   * nothing to do with the thing that was pressed.
   *
   * A function, not a rect, because the popover re-reads it on every scroll —
   * a static rect would leave the panel behind the moment the page moved.
   */
  getAnchor?: () => DOMRect | null;
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
   * Open a comment, from any of the three affordances that ask for one.
   *
   * @remarks
   * A comment used to be **on a block** and nothing else, which was the right
   * first shape and too narrow: the thing people want to argue about is
   * usually a sentence. There are three ways in now, and {@link CommentContext}
   * is how they differ — the gutter button passes nothing and means the whole
   * block, the format toolbar passes the selected `range`, and clicking an
   * existing yellow highlight passes its `threadId`.
   *
   * The threads themselves are the host's: `@nbe/core` has the model and
   * `@nbe/collab` puts it in the CRDT, but *where a discussion is displayed* is
   * a layout decision the editor cannot make — a sidebar, a popover, a panel in
   * another pane. So the editor contributes the affordance and nothing else,
   * and without this host neither the button nor the toolbar entry is rendered
   * at all, rather than rendered dead.
   *
   * @param blockId - The block the affordance was on.
   * @param author - `commentAuthor`, or `null` when nobody was named.
   * @param context - Which of the three, and what it was pointing at. Absent
   * means the whole block, which is what every existing host already handles.
   */
  onComment?: (blockId: BlockId, author: CommentAuthor | null, context?: CommentContext) => void;
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
   * What the margin marker counts, when threads are not the honest answer.
   *
   * @remarks
   * The document knows how many *threads* a block carries — each is a `comment`
   * mark with a `threadId` — and that needed no host API, which is why the
   * marker had none. It is the wrong number to show: three comments made one
   * after another join one thread, so the margin said "1" beside a panel with
   * three messages in it.
   *
   * The messages are the host's, so the host counts them. Call
   * {@link refreshCommentMarkers} after a change the document cannot see —
   * a reply adds no mark, so nothing else tells the margin.
   *
   * @param blockId - The block being marked.
   * @param threadIds - The threads anchored on it, in document order.
   * @returns How many comments to show. Defaults to `threadIds.length`.
   */
  commentCount?: (blockId: BlockId, threadIds: readonly string[]) => number;
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
  /** Notified after the view writes to the DOM. See {@link EditorView.onRender}. */
  private renderListeners = new Set<(ids: readonly BlockId[] | null) => void>();
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

    this.renderProgressively();
    /*
     * The view listens *before* anything it renders for.
     *
     * `Editor.emit` calls listeners in registration order, so a feature that
     * subscribed first ran against the DOM the re-render was about to throw
     * away: every `Range` it measured came back pointing at a detached leaf,
     * every rect at a stale position. Three features had each grown their own
     * `queueMicrotask` to step around it; the ones that had not — the syntax
     * colours, the cross-block selection, a peer's caret — simply stopped
     * painting the moment anyone typed.
     */
    this.unbinders.push(editor.on((change) => this.handleChange(change)));
    this.unbinders.push(editor.onSelection((sel, origin) => this.renderSelection(sel, origin)));
    // features are data: what a host leaves out is not attached and not bundled
    for (const f of options.features ?? (this.readOnly ? [] : defaultFeatures)) {
      this.unbinders.push(f.attach(this));
    }
    // a block plugin's own features, after the editor's: a table's cell
    // selection contributes a recognizer, and precedence is registration order
    if (!this.readOnly)
      for (const plugin of this.plugins.all())
        for (const f of viewOf(plugin)?.features ?? []) this.unbinders.push(f.attach(this));

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
      if (leafText(leaf) !== modelText) {
        // text changed outside our pipeline (Grammarly accept, autofill…):
        // treat it as user intent and diff it into the model
        reconcileLeaf(this, leaf);
      } else {
        // same text but foreign markup (highlight spans, style attributes):
        // the model re-render is the canonical cleanup
        const repaired = this.withObserverPaused(() => {
          const current = this.blockEl(id);
          if (!current?.isConnected) return false;
          replaceBlockEl(current, renderBlock(this, id));
          return true;
        });
        if (repaired) this.rendered([id]);
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
    for (const slot of this.slots.values()) slot.remove();
    this.slots.clear();
    this.announcer?.remove();
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

  /**
   * Called after the view has written to the DOM.
   *
   * @remarks
   * Anything measured *from* the DOM — a `Range` parked in `CSS.highlights`, an
   * overlay placed from a rect — dies when the element under it is replaced,
   * and `editor.on` is not when to redo it. A render can have no transaction
   * behind it at all: a peer's edit arriving through `renderAll`, a composition
   * paid back when the IME commits, an extension's markup reverted. Those
   * repaint the surface and emit no change, which is why the syntax colours
   * used to survive typing but not a collaborator.
   *
   * @param cb - Receives the blocks whose elements were replaced, or `null`
   * when the whole surface was rebuilt.
   * @returns An unsubscribe.
   */
  onRender(cb: (ids: readonly BlockId[] | null) => void): () => void {
    this.renderListeners.add(cb);
    return () => this.renderListeners.delete(cb);
  }

  private rendered(ids: readonly BlockId[] | null): void {
    for (const cb of this.renderListeners) cb(ids);
  }

  /** The element rendering a block, or `null` if it is not on screen. */
  blockEl(id: string): HTMLElement | null {
    const found = this.content.querySelector<HTMLElement>(`.nbe-block[data-block-id="${CSS.escape(id)}"]`);
    if (found || !this.tail) return found;
    // a mount still streaming its tail: finish it rather than answer `null`.
    // Every consumer that needs an element — the caret, find, a page anchor —
    // comes through here, so this is the one place the deferral has to be
    // invisible, and it is why nothing else in the codebase had to change.
    this.flushTail();
    return this.content.querySelector<HTMLElement>(`.nbe-block[data-block-id="${CSS.escape(id)}"]`);
  }

  /** The editable leaf inside a block, where its text lives. */
  leafEl(id: string): HTMLElement | null {
    const found = this.content.querySelector<HTMLElement>(`.nbe-leaf[data-block-id="${CSS.escape(id)}"]`);
    if (found || !this.tail) return found;
    this.flushTail();
    return this.content.querySelector<HTMLElement>(`.nbe-leaf[data-block-id="${CSS.escape(id)}"]`);
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
    this.tail = null; // a full render supersedes whatever was still streaming
    const root = getBlock(this.editor.doc, this.editor.doc.rootId);
    this.withObserverPaused(() =>
      this.content.replaceChildren(...root.children.map((id) => renderBlock(this, id))),
    );
    this.rendered(null);
  }

  /**
   * Block ids of the opening mount that have not been built yet.
   *
   * @remarks
   * `null` whenever the surface is whole, which is every moment except the few
   * frames after a long document is first mounted.
   */
  private tail: BlockId[] | null = null;

  /**
   * First paint now, the rest of a long document over the next few frames.
   *
   * @remarks
   * Measured before it was written, which is the reason it looks like this
   * rather than like a virtualizer. At 500 / 2000 / 5000 blocks a keystroke
   * costs 8.3 / 8.3 / 8.4 ms and a scrolled frame 7.7 / 7.8 / 7.6 ms — flat,
   * both of them, because a keystroke already repaints one block and the
   * browser is perfectly happy scrolling fifteen thousand nodes. **The only
   * thing that scales with document length is the opening render**: 191ms,
   * 404ms, 1010ms. So that is the only thing this touches.
   *
   * A virtualizer would have fixed the same second and put every off-screen
   * block out of the DOM — where the caret, find, the comment markers and
   * every `blockEl` call expect to find them. `content-visibility: auto` was
   * tried too, as the native answer: **ten times worse** (9946ms) and three
   * times the scroll cost, measured, not guessed.
   *
   * Only the opening mount is deferred, never an edit-driven re-render: those
   * are followed by a caret sync that has to see the finished DOM. And
   * {@link EditorView.blockEl} flushes the tail on demand, so nothing outside
   * this class can observe a half-built document.
   */
  private renderProgressively(): void {
    const root = getBlock(this.editor.doc, this.editor.doc.rootId);
    // more than a screenful and a half; below that the whole thing is cheaper
    // than the bookkeeping
    if (root.children.length <= FIRST_PAINT) return this.renderAll();
    const ids = [...root.children];
    this.withObserverPaused(() =>
      this.content.replaceChildren(...ids.slice(0, FIRST_PAINT).map((id) => renderBlock(this, id))),
    );
    this.tail = ids.slice(FIRST_PAINT);
    this.rendered(null);
    const step = () => {
      if (!this.tail?.length) {
        this.tail = null;
        return;
      }
      const batch = this.tail.splice(0, TAIL_BATCH);
      const more = this.tail.length > 0;
      // cleared *before* the listeners run, so `whenComplete` can answer from
      // the same state they see
      if (!more) this.tail = null;
      this.withObserverPaused(() => this.content.append(...batch.map((id) => renderBlock(this, id))));
      this.rendered(batch);
      if (more) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Resolves once a streamed opening render has finished.
   *
   * @remarks
   * For a host that has to do something with the *whole* document as soon as
   * it exists — Obsidian restoring the reader's scroll position across a
   * rebuild, for one. Already-resolved when nothing is streaming, which is
   * every moment except the few frames after a long document is mounted.
   */
  whenComplete(): Promise<void> {
    if (!this.tail) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onRender(() => {
        if (this.tail) return;
        off();
        resolve();
      });
    });
  }

  /** Build whatever is left of the opening mount, now. */
  private flushTail(): void {
    const rest = this.tail;
    if (!rest?.length) {
      this.tail = null;
      return;
    }
    this.tail = null;
    this.withObserverPaused(() => this.content.append(...rest.map((id) => renderBlock(this, id))));
    this.rendered(rest);
  }

  /**
   * Where a block's children are rendered, when they can be reconciled there.
   *
   * @remarks
   * Read off the DOM rather than assumed: the default renderer puts children
   * in a `.nbe-children` wrapper, a layout container (a column, a table row)
   * puts them straight in its own element, and a plugin with its own `render`
   * puts them wherever it likes. Asking an element that is already on screen
   * where it lives answers for all three.
   *
   * `null` — and so a plain rebuild, which is what always happened — when the
   * block has no child on screen to ask (a first insert, a collapsed toggle),
   * or when the host holds anything that is not a block: the reconcile walks
   * its children in document order, and chrome interleaved among them would be
   * shuffled to the end.
   */
  private childHost(id: BlockId): HTMLElement | null {
    if (id === this.editor.doc.rootId) return this.content;
    const el = this.blockEl(id);
    if (!el) return null;
    for (const childId of getBlock(this.editor.doc, id).children) {
      // inside this block, not merely somewhere: a child that is about to be
      // nested under it is still rendered under its *old* parent, and taking
      // that parent for this block's host reconciles the wrong list
      const childEl = this.blockEl(childId);
      if (!childEl || !el.contains(childEl)) continue;
      const host = childEl.parentElement!;
      return [...host.children].every((c) => (c as HTMLElement).dataset?.['blockId']) ? host : null;
    }
    return null;
  }

  /**
   * Bring a host's child elements in line with the document, keeping the ones
   * that are already there.
   *
   * @remarks
   * The blink this exists for: **an `<iframe>` reloads the page it is showing
   * whenever it is re-created _or re-parented_**, and an `<img>` flashes while
   * it decodes again. Rebuilding a parent to insert one child therefore
   * restarted every video in it, and since a top-level parent is the root,
   * pressing Enter restarted every video in the note.
   *
   * So elements are matched by block id and *moved* — with `moveBefore` where
   * the browser has it, which is the only relocation the platform offers that
   * a frame survives. A block arriving from another parent is looked up across
   * the whole surface, not just here, so a move between parents transfers the
   * one element instead of building a second.
   */
  private reconcile(
    host: HTMLElement,
    ids: readonly BlockId[],
    wrote: BlockId[],
    dropped: Array<[HTMLElement, HTMLElement]>,
  ): void {
    const have = new Map<BlockId, HTMLElement>();
    for (const child of host.children) {
      const id = (child as HTMLElement).dataset?.['blockId'];
      if (id) have.set(id, child as HTMLElement);
    }
    let ref = host.firstElementChild;
    for (const id of ids) {
      const cur = have.get(id) ?? this.blockEl(id);
      have.delete(id);
      if (cur && cur === ref) {
        ref = ref.nextElementSibling; // already in place
        continue;
      }
      if (cur) moveInto(host, cur, ref);
      else host.insertBefore(renderBlock(this, id), ref);
      wrote.push(id);
    }
    for (const el of have.values()) dropped.push([el, host]);
  }

  /** Re-count a host's numbered list items, which only their siblings know. */
  private renumber(host: HTMLElement): void {
    let n = 0;
    for (const child of host.children) {
      const id = (child as HTMLElement).dataset?.['blockId'];
      if (this.editor.doc.blocks.get(id ?? '')?.type !== 'numbered_list_item') {
        n = 0;
        continue;
      }
      n++;
      const gutter = child.querySelector(':scope > .nbe-row > .nbe-number');
      if (gutter) gutter.textContent = `${n}.`;
    }
  }

  private handleChange(change: Change): void {
    /*
     * Nothing but `reveal` may move the page across an edit.
     *
     * The editor's own scrolling has been narrowed to one function that asks
     * first, and the page kept moving anyway — because the editor is not the
     * only thing on it. The browser scrolls on focus, a host scrolls when a
     * pane's content changes height, and Chromium's scroll anchoring picks a
     * new anchor when the DOM above the fold is replaced. All three read to
     * the person typing as "it scrolled by itself", and none is reachable from
     * here. So the outcome is guarded rather than the causes chased.
     */
    const release = holdScroll(this.content);
    try {
      this.applyChange(change);
    } finally {
      release();
    }
  }

  private applyChange(change: Change): void {
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
    const target = (id: BlockId): BlockId => {
      const block = doc.blocks.get(id);
      return block?.type === 'table_row' && block.parentId ? block.parentId : id;
    };
    /*
     * Two kinds of dirty, told apart by the ops rather than guessed at.
     *
     * A block is dirty because *it* changed — its text, its props, its type —
     * and then its element has to be built again. Or it is dirty because a
     * **child list** changed under it, which is the only other thing an op
     * marks: `insert_block`, `delete_block` and `move_block` all dirty the
     * parent. That second kind used to be rebuilt like the first, and for a
     * top-level block the parent *is* the root, so pressing Enter or dragging
     * a block one place up rebuilt the entire document. See
     * {@link EditorView.reconcile} for what it costs.
     */
    const rebuild = new Set<BlockId>();
    for (const op of change.ops) {
      if (op.type === 'insert_block' || op.type === 'delete_block' || op.type === 'move_block') continue;
      if (doc.blocks.has(op.id)) rebuild.add(target(op.id));
    }
    const hosts: BlockId[] = [];
    for (const id of change.dirty) {
      if (!doc.blocks.has(id)) continue;
      // a dirty row is the table's problem either way, child list included:
      // the column template is computed from the cells and lives on the table
      if (target(id) !== id) rebuild.add(target(id));
      else if (!rebuild.has(id)) hosts.push(id);
    }
    // what `onRender` reports: the elements actually written, or nothing when
    // a full rebuild already announced itself
    const replaced: BlockId[] = [];
    let full = false;
    /*
     * Child lists first: a reconcile is what builds the element an insert
     * brought in, and rebuilding its parent afterwards would only throw that
     * element away. Deferred removals, because a block moved from one parent
     * to another must be *taken* by its new host before its old one drops it —
     * dropping it first would destroy the node and reload every frame in it.
     */
    const dropped: Array<[HTMLElement, HTMLElement]> = [];
    const reconciled: HTMLElement[] = [];
    for (const id of hosts) {
      if (ancestors(doc, id).some((p) => rebuild.has(p))) continue;
      const host = this.childHost(id);
      if (!host) {
        rebuild.add(target(id)); // nowhere to reconcile into: rebuild the block
        continue;
      }
      reconciled.push(host);
      this.withObserverPaused(() => this.reconcile(host, getBlock(doc, id).children, replaced, dropped));
    }
    if (reconciled.length) {
      this.withObserverPaused(() => {
        /*
         * Every host has had its turn, so anything still sitting where it was
         * left was not claimed by a new parent: it was deleted, or its new
         * parent is about to be rebuilt and will render its own copy. Either
         * way it goes now rather than after, so that no id is in the document
         * twice while the rebuilds below look elements up.
         */
        for (const [el, host] of dropped) if (el.parentElement === host) el.remove();
        // a list's numbers are a property of the *siblings*, so the one thing a
        // moved element cannot bring with it is its own number
        for (const host of reconciled) this.renumber(host);
      });
    }
    // skip ids whose ancestor is also dirty — the ancestor re-render covers them
    const roots = [...rebuild].filter((id) => !ancestors(doc, id).some((p) => rebuild.has(p)));
    for (const id of roots) {
      if (id === doc.rootId) {
        full = true;
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
          if (old?.isConnected) {
            replaceBlockEl(old, renderBlock(this, id));
            replaced.push(id);
          } else {
            full = true;
            this.renderAll(); // lost track — a full re-render is always correct
          }
        });
      }
    }
    if (!full && replaced.length) this.rendered(replaced);
    // only re-assert the DOM caret when the transaction moved the selection —
    // ui/programmatic changes must never yank the caret from where the user put it
    if (change.origin !== 'dom' && change.selectionSet) {
      this.syncDomSelection();
    } else if (caretBefore && !domTextSelection(this)) {
      /*
       * The re-render destroyed the caret: restore the pre-render DOM truth,
       * and **do not scroll to it**. Putting a caret back where it visibly was
       * cannot, by definition, require moving the page — and a block move
       * dirties the root, so `renderAll` runs and every caret goes through
       * here. Dragging a block at the top of a long page, with a caret left in
       * the last one, therefore threw the page down to that caret the moment
       * the block landed. The caret was never what moved.
       */
      this.editor.setSelection(caretBefore, 'dom');
      this.syncDomSelection(false);
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
  syncDomSelection(scrollIntoView = true): void {
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
    if (scrollIntoView && leaf) reveal(leaf);
  }

  /** Move the caret to a block (used by keyboard navigation). */
  /** Put the caret in a block, at a character offset, and focus it. */
  focusBlock(id: string, offset: number): void {
    this.editor.setSelection(textCaret(id, offset));
    this.syncDomSelection();
  }

  private slots = new Map<SlotName, HTMLElement>();

  /**
   * A place for chrome that is not a block.
   *
   * @remarks
   * A feature can already attach anything; what it had nowhere to put was
   * anything *persistent* — `renderAll` replaces every child of the content
   * element, so a word counter appended there vanishes on the next remote
   * edit. A slot is a sibling of the content, which is where the live region
   * has always lived for exactly this reason, so nothing the renderer does can
   * reach it.
   *
   * Three, because three is what the questions asked for and no more: `top`
   * for what belongs above the document (a cover, a title bar), `bottom` for
   * what follows it (a word count, a footer), and `floating` for what sits
   * over it without taking space (a reading-progress bar, a mini outline).
   * Created on demand — a slot nobody asked for is not in the DOM — and
   * removed with the view.
   *
   * @example
   * ```ts
   * const feature: EditorFeature = {
   *   name: 'word-count',
   *   attach(view) {
   *     const el = view.slot('bottom')
   *     …
   *   },
   * }
   * ```
   */
  slot(where: SlotName): HTMLElement {
    const existing = this.slots.get(where);
    if (existing) return existing;
    const el = document.createElement('div');
    /*
     * `nbe-portal` because a slot is *outside* `.nbe-editor` — it is a sibling
     * of the content element, which is the whole point of it — and the tokens
     * are scoped to the editor and the portals. Without the marker every slot
     * painted with `var(--nbe-surface)` and friends undefined: the floating
     * outline came out transparent over the text, unreadable, with nothing
     * highlighted. The class is the documented marker for exactly this — chrome
     * mounted outside the editor (see `style/tokens.css`).
     */
    el.className = `nbe-portal nbe-slot nbe-slot-${where}`;
    el.dataset['nbeUi'] = '';
    if (where === 'top') this.content.before(el);
    else this.content.after(el);
    this.slots.set(where, el);
    return el;
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
