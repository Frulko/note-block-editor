import { uuidv7, type BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from '@nbe/workspace';
import { indexedDbStorage } from '@nbe/workspace/idb';
import type { CollectionRecord } from './dbhost';

export interface Workspace {
  pages: BlockJSON[]; // each root is a 'page' block; page id = root id
  openId: string;
  /** phase 3: collection schemas + view configs; rows are pages above */
  collections?: CollectionRecord[];
}

const LEGACY_KEY = 'nbe-workspace-v1';
const META_KEY = 'nbe-workspace-meta-v1';

/**
 * Pages in IndexedDB, one record each; everything else in localStorage.
 *
 * @remarks
 * The split is not arbitrary. **Pages** are the workspace — §2.2's one
 * document per page — and they belong in a store that is asynchronous, holds
 * structured clones, and is not capped at a few megabytes. localStorage was
 * capped, and an image-bearing workspace hit that cap.
 *
 * **Everything else is not a page**: which page is open is UI state, and the
 * collection schemas and view configs are *host* records the editor asks a
 * `DatabaseHost` for (§2.5). Neither is content, both are tiny, and keeping
 * them in localStorage means the boot can render the shell before the pages
 * have arrived.
 *
 * A workspace saved by an earlier build is migrated on first load and the old
 * key removed, so nobody loses a page to a storage change.
 */
const pages = indexedDbStorage('nbe-demo-workspace');

interface Meta {
  openId: string;
  collections?: CollectionRecord[];
}

function readMeta(): Meta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Meta) : null;
  } catch {
    return null;
  }
}

/** Pages saved by the localStorage-era build, or null if there are none. */
function legacyWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const ws = JSON.parse(raw) as Workspace;
    return ws.pages?.length ? ws : null;
  } catch {
    return null;
  }
}

export async function loadWorkspace(seed: () => BlockJSON): Promise<Workspace> {
  const legacy = legacyWorkspace();
  if (legacy) {
    // migrate once, then drop the old key so this never runs again
    for (const page of legacy.pages) await pages.write(page.id, page);
    localStorage.setItem(META_KEY, JSON.stringify({ openId: legacy.openId, collections: legacy.collections }));
    localStorage.removeItem(LEGACY_KEY);
  }

  const ids = await pages.list();
  const stored: BlockJSON[] = [];
  for (const id of ids) {
    const page = await pages.read(id);
    if (page) stored.push(page);
  }

  const meta = readMeta();
  if (!stored.length) {
    const first = seed();
    await pages.write(first.id, first);
    return { pages: [first], openId: first.id, collections: meta?.collections };
  }
  const openId = stored.some((p) => p.id === meta?.openId) ? meta!.openId : stored[0]!.id;
  return { pages: stored, openId, collections: meta?.collections };
}

/**
 * What has been written, so a save only writes what changed.
 *
 * @remarks
 * Comparing serialized pages is cheap next to an IndexedDB round trip, and
 * without it every keystroke would rewrite every page in the workspace — which
 * is precisely the whole-blob behaviour the per-page granularity exists to
 * avoid.
 */
const written = new Map<string, string>();
let saveTimer = 0;
let pending: Workspace | null = null;

export function flushWorkspace(): void {
  if (!pending) return;
  const ws = pending;
  pending = null;
  clearTimeout(saveTimer);

  localStorage.setItem(META_KEY, JSON.stringify({ openId: ws.openId, collections: ws.collections }));
  const live = new Set(ws.pages.map((p) => p.id));
  for (const page of ws.pages) {
    const json = JSON.stringify(page);
    if (written.get(page.id) === json) continue;
    written.set(page.id, json);
    void pages.write(page.id, page);
  }
  for (const id of [...written.keys()]) {
    if (live.has(id)) continue;
    written.delete(id);
    void pages.remove(id);
  }
}

const flush = flushWorkspace;

export function saveWorkspace(ws: Workspace): void {
  pending = ws;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 300);
}

// background tabs throttle timers (a debounced save may never fire before the
// tab dies) — flush on hide/close, the local-first way
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

export async function resetWorkspace(): Promise<void> {
  localStorage.removeItem(META_KEY);
  localStorage.removeItem(LEGACY_KEY);
  for (const id of await pages.list()) await pages.remove(id);
  location.reload();
}

export function createPage(ws: Workspace, title: string): BlockJSON {
  const page: BlockJSON = {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: { title },
    children: [
      { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: title ? [{ text: title }] : [] },
      { id: uuidv7(), type: 'paragraph', version: 1, text: [] },
    ],
  };
  ws.pages.push(page);
  return page;
}

/** Page title for the sidebar: first non-empty text, else the title prop. */
export function pageTitle(page: BlockJSON): string {
  for (const child of page.children ?? []) {
    const text = (child.text ?? []).map((r) => r.text).join('');
    if (text.trim()) return text.trim().slice(0, 40);
  }
  return String(page.props?.['title'] ?? '') || 'Sans titre';
}

/**
 * The demo's page array, exposed as a {@link WorkspaceStorage}.
 *
 * @remarks
 * ROADMAP phase 4 introduces `@nbe/workspace`, whose whole model is that the
 * page tree is *derived* from `sub_page` blocks rather than stored. That means
 * it can run over anything that can hand it pages one at a time — including
 * this array. So the demo keeps its localStorage persistence and its database
 * host, which mutate `ws.pages` directly, and still gets a real tree.
 *
 * `@nbe/workspace/idb` is the adapter a real app would use; swapping to it is
 * a one-line change here once the demo's boot goes async.
 */
export function pageStorage(ws: Workspace): WorkspaceStorage {
  return {
    list: async () => ws.pages.map((p) => p.id),
    read: async (id) => ws.pages.find((p) => p.id === id) ?? null,
    write: async (id, page) => {
      const at = ws.pages.findIndex((p) => p.id === id);
      if (at >= 0) ws.pages[at] = page;
      else ws.pages.push(page);
      saveWorkspace(ws);
    },
    remove: async (id) => {
      ws.pages = ws.pages.filter((p) => p.id !== id);
      saveWorkspace(ws);
    },
  };
}
