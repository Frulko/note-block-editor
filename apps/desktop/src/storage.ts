import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import type { BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from '@nbe/workspace';
import { memoryStorage } from '@nbe/workspace';
import { memoryCollections } from '@nbe/workspace/database';
import type { CollectionRecord, CollectionStore } from '@nbe/workspace/database';

/**
 * Pages as files, in the folder the user chose.
 *
 * @remarks
 * This is the only piece of this application that did not already exist. The
 * page tree, the Markdown projection, search, backlinks, the importers — all
 * of it is `@nbe/workspace`, which asks for four methods and knows nothing
 * about where they lead. A desktop build therefore needs a filesystem, not a
 * second implementation.
 *
 * `@nbe/cli` has the same four methods over `node:fs`. They are separate files
 * rather than one shared module because they share no code: Node and Tauri
 * expose different APIs, and the thing worth sharing — what a page store *is*
 * — is the interface, which they both satisfy.
 *
 * **Writes are atomic** (AQ#1): a temporary file in the same directory, then
 * `rename` over the target. Rename within a filesystem is atomic, so a reader
 * — including Obsidian, or a sync client watching the folder — sees the old
 * page or the new one and never a half-written one. Writing in place would
 * leave truncated JSON after a crash, and a truncated page is a lost page.
 *
 * @category Storage
 */

/** Where the canonical documents live, beside the Markdown a person reads. */
export const PAGES_DIRECTORY = '.nbe';

/**
 * Reject an id that would write outside the folder it belongs to.
 *
 * @remarks
 * The same rule lives in `@nbe/cli`'s storage, because the two runtimes expose
 * different filesystem APIs and only the *interface* is shared. This particular
 * function is pure string logic and could be shared — it is not, and
 * `test/restraint.test.ts` asserts the two copies stay identical instead. A
 * security rule kept in two places drifts in the direction that matters:
 * someone tightens one against a new traversal vector and the other stays open.
 */
function safeName(id: string): string {
  if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`identifiant de page invalide : ${JSON.stringify(id)}`);
  }
  return `${id}.json`;
}

export function vaultStorage(root: string): WorkspaceStorage {
  const directory = `${root}/${PAGES_DIRECTORY}`;
  const ensure = async () => {
    if (!(await exists(directory))) await mkdir(directory, { recursive: true });
  };

  return {
    list: async () => {
      await ensure();
      const entries = await readDir(directory);
      return entries
        .filter((entry) => entry.isFile && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length));
    },

    read: async (id) => {
      const path = `${directory}/${safeName(id)}`;
      if (!(await exists(path))) return null;
      try {
        return JSON.parse(await readTextFile(path)) as BlockJSON;
      } catch {
        /*
         * A page that will not parse is not a missing page. Returning null
         * would hide it from the tree and the next Markdown sync would then
         * write a vault without it — so it is skipped loudly instead.
         */
        console.error(`[carnet] page illisible, ignorée : ${path}`);
        return null;
      }
    },

    write: async (id, page) => {
      await ensure();
      const target = `${directory}/${safeName(id)}`;
      const temp = `${target}.tmp`;
      await writeTextFile(temp, `${JSON.stringify(page, null, 2)}\n`);
      await rename(temp, target);
    },

    remove: async (id) => {
      const path = `${directory}/${safeName(id)}`;
      if (await exists(path)) await remove(path);
    },
  };
}

/** Write a file, creating the directories above it. */
export async function writeInto(root: string, relative: string, text: string): Promise<void> {
  const path = `${root}/${relative}`;
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent && !(await exists(parent))) await mkdir(parent, { recursive: true });
  await writeTextFile(path, text);
}

/**
 * Remove a directory and everything under it, if it is there.
 *
 * @remarks
 * Used for the Markdown mirror, which is rebuilt rather than patched: a
 * renamed page changes its path, and patching would leave the old file behind
 * as a second copy that the next import reads back as a second page.
 */
export async function clearDirectory(path: string): Promise<void> {
  if (await exists(path)) await remove(path, { recursive: true });
}

/**
 * Collection schemas and views, in one file beside the pages.
 *
 * @remarks
 * These are workspace-level records, not pages (§2.5), so they do not belong
 * in {@link WorkspaceStorage} — which is deliberately four methods about pages
 * and nothing else. A handful of small objects, read once and rewritten whole,
 * is a file.
 *
 * Written the same atomic way as a page: a crash mid-write would otherwise
 * leave truncated JSON, and a truncated collections file is every database in
 * the workspace at once.
 */
export function collectionStore(root: string): CollectionStore {
  const path = `${root}/${PAGES_DIRECTORY}/collections.json`;
  return {
    read: async () => {
      if (!(await exists(path))) return [];
      try {
        const parsed = JSON.parse(await readTextFile(path)) as unknown;
        return Array.isArray(parsed) ? (parsed as CollectionRecord[]) : [];
      } catch {
        console.error(`[carnet] collections illisibles, ignorées : ${path}`);
        return [];
      }
    },
    write: async (records) => {
      const directory = `${root}/${PAGES_DIRECTORY}`;
      if (!(await exists(directory))) await mkdir(directory, { recursive: true });
      const temp = `${path}.tmp`;
      await writeTextFile(temp, `${JSON.stringify(records, null, 2)}\n`);
      await rename(temp, path);
    },
  };
}

/**
 * True when the native filesystem is reachable.
 *
 * @remarks
 * The Tauri APIs exist only inside its webview. Outside — `vite dev` opened in
 * a browser — every call throws, and the application was therefore impossible
 * to look at without building and launching a window.
 *
 * That mattered more than it sounds: a cursor landing in the wrong place was
 * reported and could not be reproduced, because there was no way to run this
 * interface anywhere a test could reach it. The fallback below is not a
 * convenience, it is what makes the app observable.
 */
export const NATIVE = typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

/** A workspace that lives only in this tab, for running the UI in a browser. */
export function scratchStorage(): WorkspaceStorage {
  return memoryStorage();
}

/** Collections to match, for the same reason. */
export function scratchCollections(): CollectionStore {
  return memoryCollections([]);
}

/* ---------------------------------------------------------------------------
   assets
   --------------------------------------------------------------------------- */

/** Where a pasted or dropped file lands, in plain sight beside the Markdown. */
export const ASSETS_DIRECTORY = 'assets';

/**
 * The bytes behind an `<img>`, a PDF preview or a download link.
 *
 * @remarks
 * The demo keeps these in IndexedDB behind an opaque `asset:<hash>` ref, which
 * is right for a browser and wrong here: this application's promise is that the
 * folder is the storage (§10), and a note whose image lives in a database only
 * this app can open breaks it. So a file is a file — content-addressed for
 * dedup, in a directory Obsidian and Finder both show, and the *path* is what
 * goes in the document, exactly as the Obsidian host stores a vault path.
 */
export interface AssetStore {
  /** Write a pasted/dropped file, return the src to persist. */
  store(blob: Blob): Promise<string>;
  /** A persisted src as something an `<img>`, `<object>` or `<iframe>` loads. */
  resolve(src: string): Promise<string>;
}

/**
 * Extension to MIME, for the handful of types the editor renders differently.
 *
 * @remarks
 * Needed because the type is not in the bytes we read back: an `<img>` sniffs
 * its own format, but a PDF viewer is chosen by Content-Type and a sandboxed
 * HTML page will not run from a blob with none. Anything absent resolves with
 * an empty type, which is what a download link wants anyway.
 */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

/** The dropped file's own extension when it has a usable one, its MIME's otherwise. */
function extensionOf(blob: Blob): string {
  const named = ((blob as File).name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (/^[a-z0-9]{1,8}$/.test(named)) return named;
  const subtype = blob.type.split('/')[1]?.replace(/\+.*$/, '') ?? '';
  return subtype === 'jpeg' ? 'jpg' : subtype || 'bin';
}

async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export function vaultAssets(root: string): AssetStore {
  const directory = `${root}/${ASSETS_DIRECTORY}`;
  // ponytail: one object URL per file per session, never revoked. Revoking
  // means knowing no element still points at it; a few dozen URLs do not.
  const urls = new Map<string, string>();

  return {
    async store(blob) {
      const bytes = await blob.arrayBuffer();
      const path = `${ASSETS_DIRECTORY}/${await contentHash(bytes)}.${extensionOf(blob)}`;
      if (!(await exists(directory))) await mkdir(directory, { recursive: true });
      // content-addressed: the same picture dropped twice is one file on disk
      if (!(await exists(`${root}/${path}`))) await writeFile(`${root}/${path}`, new Uint8Array(bytes));
      return path;
    },

    async resolve(src) {
      // an http, data or blob src is already loadable; only a vault path is not
      if (/^(https?:|data:|blob:)/.test(src)) return src;
      const cached = urls.get(src);
      if (cached) return cached;
      const bytes = await readFile(`${root}/${decodeURI(src)}`);
      const type = MIME[src.split('.').pop()?.toLowerCase() ?? ''] ?? '';
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      urls.set(src, url);
      return url;
    },
  };
}

/** Files that live only in this tab, for the browser build. */
export function memoryAssets(): AssetStore {
  return {
    store: async (blob) => URL.createObjectURL(blob),
    resolve: async (src) => src,
  };
}

/* ---------------------------------------------------------------------------
   CRDT snapshots
   --------------------------------------------------------------------------- */

/** Where a page's live document lives, beside its JSON. */
export const SNAPSHOTS_DIRECTORY = `${PAGES_DIRECTORY}/rooms`;

/**
 * A page's CRDT document, on disk.
 *
 * @remarks
 * **Why this exists at all**, given the JSON beside it: because a document
 * cannot be rebuilt from its content. Two peers that each construct a `LoroDoc`
 * from identical JSON do not converge — they merge to every block twice, since
 * the identity Loro tracks is the tree node it created, not the id written
 * inside it. That is a passing test
 * (`packages/collab/test/seeding.test.ts`), not a guess. So peers share a
 * *document*, and this is where it is kept.
 *
 * **The JSON stays canonical for portability, and this stays canonical for
 * editing.** They are not the same fact twice: the JSON is what survives the
 * app being deleted (§10, and the vault projects from it), and the snapshot is
 * what carries the history and the merge identity that JSON has nowhere to put.
 * The snapshot is written from the document; the JSON is written from the same
 * document. Neither is derived from the other, so neither can go stale against
 * it.
 *
 * **Losing a snapshot is recoverable; losing the JSON is not.** So a missing or
 * unreadable snapshot is not an error — the page opens from its JSON and a new
 * document begins. The cost is the old history, which is the right thing to
 * lose in that trade.
 */
export interface SnapshotStore {
  read(pageId: string): Promise<Uint8Array | null>;
  write(pageId: string, bytes: Uint8Array): Promise<void>;
  remove(pageId: string): Promise<void>;
}

export function vaultSnapshots(root: string): SnapshotStore {
  const directory = `${root}/${SNAPSHOTS_DIRECTORY}`;
  const ensure = async () => {
    if (!(await exists(directory))) await mkdir(directory, { recursive: true });
  };
  const file = (id: string) => `${directory}/${safeName(id).replace(/\.json$/, '.loro')}`;

  return {
    async read(pageId) {
      try {
        const path = file(pageId);
        return (await exists(path)) ? await readFile(path) : null;
      } catch {
        // an unreadable snapshot costs history, not content — the JSON remains
        return null;
      }
    },
    async write(pageId, bytes) {
      await ensure();
      const path = file(pageId);
      // same temp-then-rename as the pages: a half-written snapshot on a crash
      // would be worse than none, because it looks readable
      const temporary = `${path}.tmp`;
      await writeFile(temporary, bytes);
      if (await exists(path)) await remove(path);
      await rename(temporary, path);
    },
    async remove(pageId) {
      const path = file(pageId);
      if (await exists(path)) await remove(path);
    },
  };
}

/** Snapshots held in memory, for a browser build with no folder open. */
export function memorySnapshots(): SnapshotStore {
  const kept = new Map<string, Uint8Array>();
  return {
    read: async (pageId) => kept.get(pageId) ?? null,
    write: async (pageId, bytes) => void kept.set(pageId, bytes),
    remove: async (pageId) => void kept.delete(pageId),
  };
}
