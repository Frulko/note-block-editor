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

/**
 * Store the bytes, not the `Blob`.
 *
 * @remarks
 * WebKit's IndexedDB refuses a `Blob` value — measured on Safari's engine, where
 * `put(new Blob(…))` errors while `getAllKeys` on the same store succeeds. Every
 * image would therefore have failed to persist on Safari and on all of iOS,
 * silently, because the write error was never surfaced. Found by running the
 * browser suite on WebKit for the first time, which is what that run was for.
 *
 * An `ArrayBuffer` is stored instead: universally supported, and the `Blob` is
 * reconstructed on read where the type matters anyway. The hash is unchanged,
 * so nothing already written needs migrating — and {@link resolveAsset} accepts
 * either shape, so a store written by an older build still reads.
 */
export async function storeAsset(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  // the type travels with the bytes: an `<img>` sniffs its own format, but a
  // PDF viewer is chosen by Content-Type, and an object URL rebuilt from a
  // bare ArrayBuffer has none. Third shape; the two older ones still read.
  await inTx('readwrite', (store) => store.put({ bytes, type: blob.type }, hash));
  return `asset:${hash}`;
}

interface StoredAsset {
  bytes: ArrayBuffer;
  type: string;
}

/** A stored value as a `Blob`, whichever of the three shapes it was written in. */
function asBlob(value: Blob | ArrayBuffer | StoredAsset | undefined): Blob | undefined {
  if (!value) return undefined;
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value]);
  return new Blob([value.bytes], value.type ? { type: value.type } : undefined);
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
  const stored = await inTx<Blob | ArrayBuffer | StoredAsset | undefined>(
    'readonly',
    (store) => store.get(src.slice(6)) as IDBRequest<Blob | ArrayBuffer | StoredAsset | undefined>,
  );
  const blob = asBlob(stored);
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
    const stored = await inTx<Blob | ArrayBuffer | StoredAsset | undefined>(
      'readonly',
      (store) => store.get(ref.slice(6)) as IDBRequest<Blob | ArrayBuffer | StoredAsset | undefined>,
    );
    const blob = asBlob(stored);
    if (blob) out.set(ref, new Uint8Array(await blob.arrayBuffer()));
  }
  return out;
}
