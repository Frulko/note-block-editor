/**
 * Demo asset store: IndexedDB blobs keyed by content hash (dedup for free),
 * exposed to the editor as opaque `asset:<hash>` refs (ARCHITECTURE AQ#2).
 * Collection is a mark-and-sweep, never reference counting: counts drift under
 * undo, multiple tabs and crashes, and a wrong count deletes an image someone
 * still has on screen. `referencedAssets` in `@nbe/workspace` is the mark;
 * {@link sweepAssets} is the sweep.
 *
 * **It runs once, at load, and that timing is the whole safety argument.** An
 * undone deletion brings its blocks back, so a blob is only garbage while
 * nothing can restore a reference to it — and the undo history lives in memory
 * and dies with the page. At load there is no history in this tab, so anything
 * unreferenced is unreachable rather than merely unused. No grace period, no
 * timestamps, no counts to keep honest.
 *
 * Known limit, stated rather than papered over: another tab open on the same
 * workspace *does* have a history, and sweeping here can strand its undo. The
 * images it currently shows survive — their object URLs are already resolved —
 * but undoing a deletion in that tab afterwards yields a broken image. The
 * multi-tab answer is a single-writer election, which belongs with phase 4b's
 * real storage rather than in a demo.
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

/**
 * Delete every stored blob that `referenced` does not mention.
 *
 * @param referenced - Opaque `asset:<hash>` refs still reachable from the
 * workspace, from `referencedAssets` in `@nbe/workspace`.
 * @returns How many blobs were freed, so a caller can say so.
 */
export async function sweepAssets(referenced: Set<string>): Promise<number> {
  const keys = await inTx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  const orphans = keys.filter((key) => !referenced.has(`asset:${String(key)}`));
  for (const key of orphans) await inTx('readwrite', (store) => store.delete(key));
  return orphans.length;
}

/** Every stored blob, as bytes, for a vault export. */
export async function allAssetBytes(refs: Iterable<string>): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const ref of refs) {
    if (!ref.startsWith('asset:')) continue;
    const blob = await inTx<Blob | undefined>('readonly', (store) => store.get(ref.slice(6)) as IDBRequest<Blob | undefined>);
    if (blob) out.set(ref, new Uint8Array(await blob.arrayBuffer()));
  }
  return out;
}
