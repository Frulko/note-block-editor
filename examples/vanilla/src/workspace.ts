import { uuidv7, type BlockJSON } from '@nbe/core';
import type { WorkspaceStorage } from '@nbe/workspace';
import type { CollectionRecord } from './dbhost';

export interface Workspace {
  pages: BlockJSON[]; // each root is a 'page' block; page id = root id
  openId: string;
  /** phase 3: collection schemas + view configs; rows are pages above */
  collections?: CollectionRecord[];
}

const KEY = 'nbe-workspace-v1';

// ponytail: localStorage single-tab persistence — the real L0 (one JSON file
// per page, atomic writes, single-writer election) is ROADMAP phase 4 / AQ#1
export function loadWorkspace(seed: () => BlockJSON): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const ws = JSON.parse(raw) as Workspace;
      if (ws.pages?.length) return ws;
    }
  } catch {
    /* corrupted → reseed */
  }
  const first = seed();
  return { pages: [first], openId: first.id };
}

let saveTimer = 0;
let pending: Workspace | null = null;

export function flushWorkspace(): void {
  if (!pending) return;
  clearTimeout(saveTimer);
  localStorage.setItem(KEY, JSON.stringify(pending));
  pending = null;
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

export function resetWorkspace(): void {
  localStorage.removeItem(KEY);
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
