import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Workspace } from '@nbe/workspace';
import { importVault } from '@nbe/workspace/vault';
import { readTree } from './index';

/**
 * Picking up edits made in another program.
 *
 * @remarks
 * This is what "file-over-app" is *for*: open the vault in Obsidian or vim,
 * edit a page, and the workspace has it. §10 calls for exactly this — external
 * edits detected and imported "through the same parser as Notion-import,
 * preserving IDs via frontmatter".
 *
 * **Polling on content hashes**, not `fs.watch`. Native watchers differ per
 * platform, miss events on network volumes, and report a save as anywhere
 * between one and four events depending on how the editor writes — many write
 * to a temp file and rename, which some watchers report as a delete. A hash
 * compared every half second is boring, portable, and cannot lie about whether
 * the bytes actually changed. The cost is a directory read per tick, on a tree
 * whose size is a person's notes.
 *
 * **An import does not write the vault back.** The user is editing those files
 * right now; normalising their line wrapping under the cursor would be rude
 * and would fight their editor's own buffer. L0 is updated, and the next
 * explicit `nbe sync` regenerates the mirror.
 *
 * **A deleted file does not delete the page.** It is reported instead. A file
 * can vanish because an editor is mid-save, because a sync client is
 * reconciling, or because someone moved it — and losing a page to any of those
 * is not recoverable from the vault, which no longer holds it.
 *
 * @category CLI
 */

export interface WatchOptions {
  /** How often to look. */
  intervalMs?: number;
  /** Called after each import, with the paths that changed. */
  onImport?: (paths: string[], pages: number) => void;
  /** Called with files that disappeared; their pages are left alone. */
  onMissing?: (paths: string[]) => void;
}

/** Content hashes of every text file in the vault, keyed by path. */
export function snapshot(vault: string): Map<string, string> {
  const out = new Map<string, string>();
  let files;
  try {
    files = readTree(vault);
  } catch {
    return out; // no vault yet: the first sync will make one
  }
  for (const file of files) {
    if (typeof file.text !== 'string') continue;
    out.set(file.path, createHash('sha256').update(file.text).digest('hex'));
  }
  return out;
}

/**
 * Watch the vault and import what changes.
 *
 * @returns A function that stops watching.
 */
export function watchVault(workspace: Workspace, root: string, opts: WatchOptions = {}): () => void {
  const vault = join(root, 'vault');
  let known = snapshot(vault);
  let running = false;

  const tick = async () => {
    if (running) return; // a slow import must not overlap the next tick
    running = true;
    try {
      const current = snapshot(vault);
      const changed = [...current.keys()].filter((path) => current.get(path) !== known.get(path));
      const missing = [...known.keys()].filter((path) => !current.has(path));
      known = current;

      if (missing.length) opts.onMissing?.(missing);
      if (!changed.length) return;

      /*
       * The whole vault is parsed, not only the changed files, because the
       * tree comes from where files *sit*: moving a page into a folder is how
       * you re-parent it, and that edit shows up as a change to one file whose
       * meaning depends on all the others.
       */
      const pages = importVault(readTree(vault));
      const byId = new Map(pages.map((page) => [page.id, page]));
      for (const page of byId.values()) await workspace.save(page.id, page);
      opts.onImport?.(changed, byId.size);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? 500);
  // never hold the process open on our own account
  timer.unref?.();
  return () => clearInterval(timer);
}
