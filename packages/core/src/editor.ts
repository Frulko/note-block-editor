import type { BlockId, Selection } from './types';
import type { Doc } from './doc';
import { createDoc } from './doc';
import type { Op } from './ops';
import { applyOp } from './ops';
import type { Schema } from './schema';
import { baseSchema } from './schema';

export interface Change {
  origin: string;
  dirty: Set<BlockId>;
  ops: Op[];
  /** True when the transaction explicitly moved the selection — the view only
   * re-asserts the DOM caret in that case (never yanks it around otherwise). */
  selectionSet: boolean;
}

export interface DispatchOptions {
  origin?: string;
  addToHistory?: boolean;
  selection?: Selection;
  /** Same key on consecutive dispatches within 500ms merges them into one undo group. */
  coalesce?: string;
}

interface HistoryEntry {
  undoOps: Op[];
  redoOps: Op[];
  selectionBefore: Selection;
  selectionAfter: Selection;
  time: number;
  coalesce?: string;
}

const COALESCE_WINDOW_MS = 500;

export class Tx {
  ops: Op[] = [];
  inverse: Op[] = [];
  dirty = new Set<BlockId>();

  constructor(
    private doc: Doc,
    private schema: Schema,
  ) {}

  op(o: Op): this {
    if (o.type === 'insert_block') this.schema.get(o.block.type); // throws on unknown type
    if (o.type === 'update_block' && o.patch.type !== undefined) this.schema.get(o.patch.type);
    const result = applyOp(this.doc, o);
    this.ops.push(o);
    this.inverse.unshift(...result.inverse);
    for (const id of result.dirty) this.dirty.add(id);
    return this;
  }
}

export class Editor {
  doc: Doc;
  schema: Schema;
  selection: Selection = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(change: Change) => void>();
  private selListeners = new Set<(sel: Selection, origin: string) => void>();

  constructor(opts: { doc?: Doc; schema?: Schema } = {}) {
    this.doc = opts.doc ?? createDoc();
    this.schema = opts.schema ?? baseSchema();
  }

  on(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSelection(listener: (sel: Selection, origin: string) => void): () => void {
    this.selListeners.add(listener);
    return () => this.selListeners.delete(listener);
  }

  /** Update selection without a transaction (caret moves are not edits). */
  setSelection(sel: Selection, origin = 'api'): void {
    this.selection = sel;
    for (const l of this.selListeners) l(sel, origin);
  }

  dispatch(build: (tx: Tx) => void, opts: DispatchOptions = {}): void {
    const selectionBefore = this.selection;
    const tx = new Tx(this.doc, this.schema);
    build(tx);
    if (tx.ops.length === 0) return;
    if (tx.ops.some((o) => o.type !== 'insert_text' && o.type !== 'delete_text' && o.type !== 'format_text')) {
      this.normalizeWrappers(tx);
    }
    if (opts.selection !== undefined) this.setSelection(opts.selection, opts.origin ?? 'dispatch');

    if (opts.addToHistory !== false) {
      const now = Date.now();
      const last = this.undoStack[this.undoStack.length - 1];
      if (
        opts.coalesce &&
        last?.coalesce === opts.coalesce &&
        now - last.time < COALESCE_WINDOW_MS
      ) {
        last.redoOps.push(...tx.ops);
        last.undoOps.unshift(...tx.inverse);
        last.selectionAfter = this.selection;
        last.time = now;
      } else {
        this.undoStack.push({
          undoOps: tx.ops.length ? tx.inverse : [],
          redoOps: tx.ops,
          selectionBefore,
          selectionAfter: this.selection,
          time: now,
          coalesce: opts.coalesce,
        });
      }
      this.redoStack = [];
    }

    this.emit({
      origin: opts.origin ?? 'unknown',
      dirty: tx.dirty,
      ops: tx.ops,
      selectionSet: opts.selection !== undefined,
    });
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const dirty = this.applyRaw(entry.undoOps);
    this.setSelection(entry.selectionBefore, 'history');
    this.redoStack.push(entry);
    this.emit({ origin: 'history', dirty, ops: entry.undoOps, selectionSet: true });
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const dirty = this.applyRaw(entry.redoOps);
    this.setSelection(entry.selectionAfter, 'history');
    this.undoStack.push(entry);
    this.emit({ origin: 'history', dirty, ops: entry.redoOps, selectionSet: true });
    return true;
  }

  /**
   * Wrapper garbage collection (ARCHITECTURE §2.3): every transaction that
   * touches structure dissolves empty columns and underfull column_lists.
   * ponytail: full scan per structural tx — fine at document scale, index later.
   */
  private normalizeWrappers(tx: Tx): void {
    for (let pass = 0; pass < 100; pass++) {
      let fixed = false;
      for (const block of [...this.doc.blocks.values()]) {
        if (!this.doc.blocks.has(block.id)) continue;
        if (block.type === 'column' && block.children.every((c) => !this.doc.blocks.has(c))) {
          tx.op({ type: 'delete_block', id: block.id });
          fixed = true;
          break;
        }
        if (block.type === 'column_list') {
          const liveCols = block.children.filter((c) => this.doc.blocks.has(c));
          if (liveCols.length < 2) {
            // unwrap: promote the surviving column's children next to the list, then delete wrappers
            let after: BlockId | null = block.id;
            for (const colId of liveCols) {
              const col = this.doc.blocks.get(colId)!;
              for (const childId of [...col.children]) {
                if (!this.doc.blocks.has(childId)) continue;
                tx.op({ type: 'move_block', id: childId, parentId: block.parentId!, after });
                after = childId;
              }
              tx.op({ type: 'delete_block', id: colId });
            }
            tx.op({ type: 'delete_block', id: block.id });
            fixed = true;
            break;
          }
        }
      }
      if (!fixed) return;
    }
  }

  private applyRaw(ops: Op[]): Set<BlockId> {
    const dirty = new Set<BlockId>();
    for (const op of ops) {
      for (const id of applyOp(this.doc, op).dirty) dirty.add(id);
    }
    return dirty;
  }

  private emit(change: Change): void {
    for (const l of this.listeners) l(change);
  }
}
