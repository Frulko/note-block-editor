import type { Change, Editor } from '@nbe/core';
import { getBlock, textCaret } from '@nbe/core';
import { renderBlock } from './render';
import { attachSelectionSync, modelPointToDom } from './selection';
import { attachInput } from './input';
import { attachKeymap } from './keymap';

export class EditorView {
  readonly editor: Editor;
  readonly content: HTMLElement;
  composing = false;
  suppressSelectionEvents = 0;

  private unbinders: Array<() => void> = [];

  constructor(container: HTMLElement, editor: Editor) {
    this.editor = editor;
    this.content = document.createElement('div');
    this.content.className = 'nbe-editor';
    container.append(this.content);

    this.renderAll();
    this.unbinders.push(attachInput(this), attachKeymap(this), attachSelectionSync(this));
    this.unbinders.push(editor.on((change) => this.handleChange(change)));
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
  }

  /** Push the model selection into the browser (after re-renders and focus moves). */
  syncDomSelection(): void {
    const sel = this.editor.selection;
    if (sel?.kind !== 'text') return;
    const anchor = modelPointToDom(this, sel.anchor);
    const head = modelPointToDom(this, sel.head);
    if (!anchor || !head) return;
    const leaf = this.leafEl(sel.head.blockId);
    this.suppressSelectionEvents++;
    leaf?.focus({ preventScroll: true });
    document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    leaf?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the caret to a block (used by keyboard navigation). */
  focusBlock(id: string, offset: number): void {
    this.editor.setSelection(textCaret(id, offset));
    this.syncDomSelection();
  }
}
