import type { Change, Editor, Selection } from '@nbe/core';
import { getBlock, selectedBlocks, textCaret } from '@nbe/core';
import { renderBlock } from './render';
import { attachSelectionSync, modelPointToDom } from './selection';
import { attachInput } from './input';
import { attachKeymap } from './keymap';
import { attachSlashMenu } from './slash';
import { attachControls } from './controls';
import { attachClipboard } from './clipboard';
import { attachRubberBand } from './rubberband';

export interface EditorViewOptions {
  onOpenPage?: (pageId: string) => void;
  /** Create a page in the host workspace (slash menu "Page" item). */
  onCreatePage?: () => { pageId: string; title: string } | null;
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
    this.unbinders.push(editor.on((change) => this.handleChange(change)));
    this.unbinders.push(editor.onSelection((sel, origin) => this.renderSelection(sel, origin)));
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
    this.content.replaceChildren(...root.children.map((id) => renderBlock(this, id)));
  }

  private handleChange(change: Change): void {
    const doc = this.editor.doc;
    const alive = [...change.dirty].filter((id) => doc.blocks.has(id));
    const set = new Set(alive);
    // skip ids whose ancestor is also dirty — the ancestor re-render covers them
    const roots = alive.filter((id) => {
      for (let p = getBlock(doc, id).parentId; p !== null; p = getBlock(doc, p).parentId) {
        if (set.has(p)) return false;
      }
      return true;
    });
    for (const id of roots) {
      if (id === doc.rootId) {
        this.renderAll();
      } else {
        const old = this.blockEl(id);
        if (old) old.replaceWith(renderBlock(this, id));
        else this.renderAll(); // ponytail: lost track — full re-render is always correct
      }
    }
    if (change.origin !== 'dom') this.syncDomSelection();
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
