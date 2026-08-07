import { exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import type { BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from '@nbe/workspace';
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

/** Reject an id that would write outside the folder it belongs to. */
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
