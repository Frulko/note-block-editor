import type { Change, Editor, Selection } from '@nbe/core';
import { ancestors, getBlock, selectedBlocks, textCaret } from '@nbe/core';
import { renderBlock } from './render';
import { attachSelectionSync, leafOf, modelPointToDom } from './selection';
import { attachInput, reconcileLeaf } from './input';
import { plainText } from '@nbe/core';
import { attachKeymap } from './keymap';
import { attachSlashMenu } from './slash';
import { attachControls } from './controls';
import { attachClipboard } from './clipboard';
import { attachRubberBand } from './rubberband';
import { attachBlockClickRouting, domTextSelection } from './caret';
import { attachDatabaseBlocks } from './database';

export interface EditorViewOptions {
  onOpenPage?: (pageId: string) => void;
  /** Create a page in the host workspace (slash menu "Page" item). */
  onCreatePage?: () => { pageId: string; title: string } | null;
  /**
   * Store a pasted/dropped binary and return the opaque src to persist
   * (convention: `asset:<content-hash>`). Without it, file paste/drop is ignored.
   */
  onStoreAsset?: (blob: Blob) => Promise<string>;
  /** Resolve a persisted src (asset:… or URL) to something an <img> can load. */
  resolveAssetUrl?: (src: string) => string | Promise<string>;
  /** Collections/views/row-pages live in the host workspace (phase 3, §2.5). */
  database?: import('./database').DatabaseHost;
}

export class EditorView {
  readonly editor: Editor;
  readonly content: HTMLElement;
  readonly options: EditorViewOptions;
  composing = false;

  private unbinders: Array<() => void> = [];

  constructor(container: HTMLElement, editor: Editor, options: EditorViewOptions = {}) {
    this.editor = editor;
    this.options = options;
    this.content = document.createElement('div');
    this.content.className = 'nbe-editor';
    this.content.tabIndex = 0; // the document's single tab stop (ARCHITECTURE §8)
    this.content.setAttribute('role', 'textbox');
    this.content.setAttribute('aria-multiline', 'true');
    container.append(this.content);

    this.renderAll();
    this.unbinders.push(attachInput(this), attachKeymap(this), attachSelectionSync(this));
    this.unbinders.push(attachSlashMenu(this), attachControls(this), attachClipboard(this), attachRubberBand(this));
    this.unbinders.push(attachBlockClickRouting(this), attachDatabaseBlocks(this));
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
          const fresh = renderBlock(this, id);
          this.blockEl(id)?.replaceWith(fresh);
        });
        this.syncDomSelection();
      }
    }
  }

  destroy(): void {
    for (const un of this.unbinders) un();
    this.content.remove();
  }

  blockEl(id: string): HTMLElement | null {
    return this.content.querySelector(`.nbe-block[data-block-id="${CSS.escape(id)}"]`);
  }

  leafEl(id: string): HTMLElement | null {
    return this.content.querySelector(`.nbe-leaf[data-block-id="${CSS.escape(id)}"]`);
  }

  renderAll(): void {
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
    const alive = [...change.dirty].filter((id) => doc.blocks.has(id));
    const set = new Set(alive);
    // skip ids whose ancestor is also dirty — the ancestor re-render covers them
    const roots = alive.filter((id) => !ancestors(doc, id).some((p) => set.has(p)));
    for (const id of roots) {
      if (id === doc.rootId) {
        this.renderAll();
      } else {
        const old = this.blockEl(id);
        if (old) this.withObserverPaused(() => old.replaceWith(renderBlock(this, id)));
        else this.renderAll(); // ponytail: lost track — full re-render is always correct
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
      this.content.focus({ preventScroll: true });
      this.blockEl(sel.head)?.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Push the model selection into the browser (after re-renders and focus moves). */
  syncDomSelection(): void {
    const sel = this.editor.selection;
    if (sel?.kind !== 'text') return;
    const anchor = modelPointToDom(this, sel.anchor);
    const head = modelPointToDom(this, sel.head);
    if (!anchor || !head) return;
    const leaf = this.leafEl(sel.head.blockId);
    leaf?.focus({ preventScroll: true });
    document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    leaf?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the caret to a block (used by keyboard navigation). */
  focusBlock(id: string, offset: number): void {
    this.editor.setSelection(textCaret(id, offset));
    this.syncDomSelection();
  }

  private announcer: HTMLElement | null = null;

  /** Screen-reader announcement (polite live region, ARCHITECTURE §8). */
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
