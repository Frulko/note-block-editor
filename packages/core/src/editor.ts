import type { Block, BlockId, Selection } from './types';
import type { Doc } from './doc';
import { createDoc } from './doc';
import { report, validateBlock, type ValidationMode } from './validate';
import type { Op } from './ops';
import { applyOp } from './ops';
import type { Schema } from './schema';
import { baseSchema } from './schema';
import { normalizeTables } from './table';

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

/**
 * The document, its schema, its selection, and the only way to change any of
 * them.
 *
 * @remarks
 * Headless on purpose: it imports nothing from the DOM, which is what lets the
 * same editor run in a browser tab, in a Node test, in an Obsidian plugin and
 * inside a Tauri window. A view is a *projection* of this object (§ Projections
 * in the guides) — delete every view and the document is still here, still
 * editable, still savable.
 *
 * **Every change goes through {@link Editor.dispatch}**, which builds a
 * transaction of the seven operations, applies it, records its inverse for
 * undo, validates only the blocks it touched, and then notifies listeners
 * once. There is no second path: a mutation that skips it is a bug, because
 * nothing would be undoable, validated, or observed.
 *
 * @example Mount, listen, edit
 * ```ts
 * import { Editor, createDoc, insertText } from '@nbe/core'
 *
 * const editor = new Editor({ doc: createDoc() })
 * const off = editor.on((change) => console.log(change.origin, change.ops))
 * insertText(editor, 'bonjour')   // a command: sugar over dispatch
 * editor.undo()
 * off()
 * ```
 *
 * @category Editing
 */
export class Editor {
  /** The live document. Read it freely; write only through {@link Editor.dispatch}. */
  doc: Doc;
  /** Which block types exist, and what they may contain. */
  schema: Schema;
  /** Where the caret or the block selection is, or `null` when nowhere. */
  selection: Selection = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(change: Change) => void>();
  private selListeners = new Set<(sel: Selection, origin: string) => void>();

  /**
   * How invalid blocks are surfaced.
   *
   * @remarks
   * `warn` by default rather than `throw`: a validation bug that takes down a
   * user's editor mid-sentence is worse than the state it was guarding
   * against, since the document is still in memory and still savable. Tests
   * and CI set `throw`.
   *
   * @defaultValue 'warn'
   */
  validation: ValidationMode;

  /**
   * @param opts - `doc` defaults to an empty page, `schema` to
   * {@link baseSchema}, and `validation` to `'warn'`.
   */
  constructor(opts: { doc?: Doc; schema?: Schema; validation?: ValidationMode } = {}) {
    this.doc = opts.doc ?? createDoc();
    this.schema = opts.schema ?? baseSchema();
    this.validation = opts.validation ?? 'warn';
  }

  /**
   * Every change, after it has been applied.
   *
   * @remarks
   * One call per transaction, not per operation: a paste that inserts forty
   * blocks notifies once, with all forty in `change.ops`. `change.origin` says
   * who caused it (`'ui'`, `'paste'`, `'history'`, whatever a caller passed),
   * which is how a host tells its own edits from a remote peer's.
   *
   * @returns An unsubscribe. Call it, or the listener outlives the host.
   *
   * @example
   * ```ts
   * const off = editor.on((change) => {
   *   if (change.origin !== 'history') save(docToJSON(editor.doc))
   * })
   * ```
   */
  on(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Caret and block-selection moves, which are not edits and so never reach
   * {@link Editor.on}.
   *
   * @returns An unsubscribe.
   */
  onSelection(listener: (sel: Selection, origin: string) => void): () => void {
    this.selListeners.add(listener);
    return () => this.selListeners.delete(listener);
  }

  /**
   * Move the selection without a transaction, because a caret move is not an
   * edit: it is not undoable and it does not mark the document dirty.
   */
  setSelection(sel: Selection, origin = 'api'): void {
    this.selection = sel;
    for (const l of this.selListeners) l(sel, origin);
  }

  /**
   * Apply a transaction: the one way the document changes.
   *
   * @remarks
   * The callback receives a {@link Tx} and calls `tx.op(…)` for each of the
   * seven operations. Everything else — the inverse for undo, wrapper and table
   * normalisation, validation of the touched blocks, and the single
   * notification — happens around it. An empty transaction is a no-op and does
   * not enter history.
   *
   * @param build - Fills the transaction.
   * @param opts - `origin` labels the change for listeners; `selection` sets
   * the selection atomically with the edit; `addToHistory: false` keeps it out
   * of undo; `coalesce` merges consecutive dispatches sharing a key within
   * 500 ms into one undo step, which is how typing undoes by word rather than
   * by keystroke.
   *
   * @example
   * ```ts
   * editor.dispatch(
   *   (tx) => tx.op({ type: 'delete_block', id }),
   *   { origin: 'ui' },
   * )
   * ```
   */
  dispatch(build: (tx: Tx) => void, opts: DispatchOptions = {}): void {
    const selectionBefore = this.selection;
    const tx = new Tx(this.doc, this.schema);
    build(tx);
    if (tx.ops.length === 0) return;
    if (tx.ops.some((o) => o.type !== 'insert_text' && o.type !== 'delete_text' && o.type !== 'format_text')) {
      /*
       * A wrapper can only *become* empty or underfull when something leaves
       * it, so an insertion cannot need this scan — and insertion is what a
       * document does constantly while growing.
       *
       * Measured before this guard: inserting two hundred blocks cost 5ms in an
       * empty document and 28ms once there were two thousand, because the scan
       * walked every block on every structural transaction. The `ponytail:`
       * note on `normalizeWrappers` predicted the ceiling ("fine at document
       * scale, index later") and it turned out to sit at roughly the size the
       * competitive survey says a document starts to hurt.
       *
       * This is not an incremental reimplementation of the rule — the scan is
       * unchanged and still exhaustive when it runs. It simply does not run
       * when nothing could have been vacated.
       */
      if (tx.ops.some((o) => o.type === 'delete_block' || o.type === 'move_block')) {
        this.normalizeWrappers(tx);
      }
      normalizeTables(this.doc, tx);
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

    // per-block validation at apply: only the blocks this transaction touched,
    // so the cost stays proportional to the edit rather than the document
    if (this.validation !== 'off') {
      const violations = [...tx.dirty]
        .map((id) => this.doc.blocks.get(id))
        .filter((b): b is Block => b !== undefined)
        .flatMap((b) => validateBlock(this.schema, b, this.doc));
      report(violations, this.validation);
    }

    this.emit({
      origin: opts.origin ?? 'unknown',
      dirty: tx.dirty,
      ops: tx.ops,
      selectionSet: opts.selection !== undefined,
    });
  }

  /** How many undo steps are available. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** How many redo steps are available. */
  get redoDepth(): number {
    return this.redoStack.length;
  }

  /**
   * Undo one step, restoring the selection it was made from.
   *
   * @returns `false` when there was nothing to undo.
   */
  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const dirty = this.applyRaw(entry.undoOps);
    this.setSelection(entry.selectionBefore, 'history');
    this.redoStack.push(entry);
    this.emit({ origin: 'history', dirty, ops: entry.undoOps, selectionSet: true });
    return true;
  }

  /**
   * Redo one step.
   *
   * @returns `false` when there was nothing to redo.
   */
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
   * ponytail: full scan, but only on a transaction that could vacate a wrapper
   * — see the guard at the call site. Measured 2026-08-08: with the guard,
   * inserting two hundred blocks costs 4ms in an empty document and 17ms at two
   * thousand; without it, 5ms and 28ms. The remaining scaling is
   * `normalizeTables`, which still walks every block unconditionally and needs
   * to know whether the document has a table without looking — a tracked flag
   * rather than a scan. Trying the obvious early-out first *was* a scan and
   * bought nothing, so it was reverted.
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
