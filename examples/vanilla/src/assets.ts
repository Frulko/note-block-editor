/**
 * Demo asset store: IndexedDB blobs keyed by content hash (dedup for free),
 * exposed to the editor as opaque `asset:<hash>` refs (ARCHITECTURE AQ#2).
 * ponytail: no GC yet — orphaned blobs accumulate until phase 4. When it comes,
 * it is a mark-and-sweep with a grace period, never reference counting:
 * refcounts drift under undo, multi-tab and crashes, and the grace period is
 * what makes undo-after-delete safe (docs/research/browser-storage.md §4).
 */

const DB_NAME = 'nbe-assets';
const STORE = 'blobs';

/**
 * One connection for the page, not one per call. Every open connection blocks
 * a future schema upgrade — silently, because `blocked` fires on the *other*
 * side — so opening per operation leaks a wedge for every asset ever touched.
 */
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // a stale tab holding this open would wedge upgrades for every other tab
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function inTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        // nothing is awaited between here and the request: a transaction goes
        // inactive the moment it sees an event-loop turn with no work pending
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function storeAsset(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  await inTx('readwrite', (store) => store.put(blob, hash));
  return `asset:${hash}`;
}

const urlCache = new Map<string, string>();

/**
 * Release every object URL this session handed out. Without it each resolved
 * image pins its blob in memory for the lifetime of the page.
 */
export function releaseAssetUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

export async function resolveAsset(src: string): Promise<string> {
  if (!src.startsWith('asset:')) return src;
  const cached = urlCache.get(src);
  if (cached) return cached;
  const blob = await inTx<Blob | undefined>('readonly', (store) => store.get(src.slice(6)) as IDBRequest<Blob | undefined>);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(src, url);
  return url;
}
