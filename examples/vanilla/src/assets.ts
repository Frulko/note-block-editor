/**
 * Demo asset store: IndexedDB blobs keyed by content hash (dedup for free),
 * exposed to the editor as opaque `asset:<hash>` refs (ARCHITECTURE AQ#2).
 * ponytail: no reference counting / GC yet — orphaned blobs accumulate until
 * phase 4's file-tree storage takes over.
 */

const DB_NAME = 'nbe-assets';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function inTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
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
