import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from '@nbe/workspace';

/**
 * Pages as real files, written so a crash cannot corrupt one.
 *
 * @remarks
 * ROADMAP phase 4b. The browser adapter answered "where do pages live" for a
 * tab; this answers it for a machine, and it is the runtime where §10's
 * acceptance test stops being hypothetical: delete the app, open the folder,
 * read everything.
 *
 * **L0 is JSON, one file per page** (§2.2), under a `.nbe/` directory. The
 * Markdown vault beside it is the L1 *projection* — regenerated from L0, never
 * the input. Keeping them apart is what stops the round trip's documented
 * losses from accumulating into the canonical copy: markdown cannot express an
 * empty block, so a vault that were canonical would quietly lose one on every
 * save.
 *
 * **Writes are atomic** (AQ#1). Every write goes to a temporary file in the
 * same directory and is then renamed over the target — `rename` within one
 * filesystem is atomic, so a reader sees the old page or the new one and never
 * a half-written one. Writing in place would leave a truncated JSON file after
 * a crash, and a truncated page is an unreadable page.
 *
 * The temporary name carries the process id, so two processes writing the same
 * page cannot collide on the temp file itself. They can still race on the
 * rename — last writer wins, which is the single-writer assumption §10 states
 * and which a real backend resolves by election rather than by luck.
 *
 * @category Storage
 */

const PAGES = '.nbe';

/** Reject a page id that would escape the directory it is stored in. */
function safeName(id: string): string {
  if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`unsafe page id: ${JSON.stringify(id)}`);
  }
  return `${id}.json`;
}

export function fileStorage(root: string): WorkspaceStorage {
  const directory = join(root, PAGES);
  const ensure = () => mkdirSync(directory, { recursive: true });

  return {
    list: async () => {
      ensure();
      return readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length));
    },

    read: async (id) => {
      try {
        return JSON.parse(readFileSync(join(directory, safeName(id)), 'utf8')) as BlockJSON;
      } catch (err) {
        // a missing page is not an error; a corrupt one must not be silent
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    write: async (id, page) => {
      ensure();
      const target = join(directory, safeName(id));
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(page, null, 2) + '\n', 'utf8');
      renameSync(temp, target);
    },

    remove: async (id) => {
      rmSync(join(directory, safeName(id)), { force: true });
    },
  };
}
