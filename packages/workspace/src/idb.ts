import type { BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from './storage';

/**
 * Pages in IndexedDB — the browser's storage for a browser's workspace.
 *
 * @remarks
 * §10, as corrected by the project owner on 2026-08-07: in the browser the
 * derived index is **whatever the browser provides**. SQLite/WASM is
 * explicitly not the browser path — it means shipping a WASM binary and a
 * single-writer worker to rebuild something the platform already stores.
 * SQLite is the *backend* runtime's answer (phase 4b), where the workspace is
 * real files on a real filesystem.
 *
 * IndexedDB rather than `localStorage`, which is what the demo used: it is
 * asynchronous so a large workspace does not block paint, it stores structured
 * clones so documents need no JSON round-trip, and it is not capped at a few
 * megabytes. One record per page, keyed by page id — the granularity
 * {@link WorkspaceStorage} exists to preserve.
 *
 * A separate entry point (`@nbe/workspace/idb`) so the package's main entry
 * stays free of browser globals and keeps working in Node, in a CLI, and in a
 * test.
 *
 * @category Storage
 */

const STORE = 'pages';

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Wrap one IDBRequest as a promise. */
function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function indexedDbStorage(databaseName = 'nbe-workspace'): WorkspaceStorage {
  // opened once, lazily: constructing a storage adapter must not be a side
  // effect, so an app can build one before deciding to use it
  let db: Promise<IDBDatabase> | null = null;
  const database = () => (db ??= open(databaseName));

  const tx = async <T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await database()).transaction(STORE, mode).objectStore(STORE);
    return run(use(store));
  };

  return {
    list: () => tx('readonly', (s) => s.getAllKeys() as IDBRequest<string[]>),
    read: async (id) => ((await tx('readonly', (s) => s.get(id))) as BlockJSON | undefined) ?? null,
    write: async (id, page) => void (await tx('readwrite', (s) => s.put(page, id))),
    remove: async (id) => void (await tx('readwrite', (s) => s.delete(id))),
  };
}
