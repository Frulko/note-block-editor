import type { BlockJSON } from '@nbe/core';

/**
 * Where pages are kept.
 *
 * @remarks
 * The seam between the notes app and whatever is underneath it — IndexedDB in
 * a browser, real files on a desktop or CLI runtime (ROADMAP phase 4b), a
 * server later. Four methods, all async, all addressing **one page at a time**,
 * because that is the shape §2.2 already committed to: one nested JSON tree
 * per page, not one blob for the workspace.
 *
 * That one-page granularity is the whole reason this is an interface rather
 * than a `localStorage` call inlined somewhere. A file backend can write one
 * page atomically (temp + rename); a workspace blob cannot be written
 * atomically at all without rewriting every page on every keystroke.
 *
 * There is deliberately no `query`, no `search`, no `listChildren`. Those are
 * derived (§10 L2) and live in {@link Workspace}, so a new adapter is four
 * methods rather than a database.
 *
 * @category Storage
 */
export interface WorkspaceStorage {
  /** Every page id held, in no particular order. */
  list(): Promise<string[]>;
  /** A page's document, or `null` if it is not there. */
  read(id: string): Promise<BlockJSON | null>;
  /** Write a page's document, replacing any previous one. */
  write(id: string, page: BlockJSON): Promise<void>;
  /** Remove a page. Removing something absent is not an error. */
  remove(id: string): Promise<void>;
}

/**
 * Pages held in memory.
 *
 * @remarks
 * The reference implementation, and what the tests run against — a workspace
 * whose behaviour depends on the adapter would be a workspace with a bug.
 * Also genuinely useful: a scratch workspace, a server-rendered preview, or a
 * test fixture that must not touch the browser.
 *
 * Documents are cloned in and out, so a caller mutating what it read cannot
 * corrupt the store behind its back — the same reason the block store keeps
 * immutable snapshots.
 *
 * @category Storage
 */
export function memoryStorage(initial: Record<string, BlockJSON> = {}): WorkspaceStorage {
  const pages = new Map<string, BlockJSON>(Object.entries(initial).map(([id, p]) => [id, clone(p)]));
  return {
    list: async () => [...pages.keys()],
    read: async (id) => {
      const page = pages.get(id);
      return page ? clone(page) : null;
    },
    write: async (id, page) => void pages.set(id, clone(page)),
    remove: async (id) => void pages.delete(id),
  };
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}
