import { uuidv7, type BlockJSON } from '@nbe/core';

export interface Workspace {
  pages: BlockJSON[]; // each root is a 'page' block; page id = root id
  openId: string;
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
export function saveWorkspace(ws: Workspace): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(KEY, JSON.stringify(ws));
  }, 300);
}

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

/** Backlink counts: pageId → number of link_to_page blocks pointing at it. */
export function backlinkCounts(ws: Workspace): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (b: BlockJSON) => {
    if (b.type === 'link_to_page') {
      const target = String(b.props?.['pageId'] ?? '');
      if (target) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    for (const c of b.children ?? []) walk(c);
  };
  for (const page of ws.pages) walk(page);
  return counts;
}
