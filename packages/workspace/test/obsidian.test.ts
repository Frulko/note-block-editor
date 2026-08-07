import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nbe/core';
import { Workspace, memoryStorage } from '../src/index';
import { exportVault } from '../src/vault';

/**
 * "An L1 workspace already *is* an Obsidian vault."
 *
 * @remarks
 * The roadmap rests the whole Obsidian decision on that sentence, and it had
 * never been checked. A vault whose links do not resolve is a folder of files
 * that merely looks like one — Obsidian shows every one of them as unresolved,
 * and the "both doors stay open" argument evaporates.
 *
 * Obsidian resolves `[[Name]]` to a file called `Name.md`, preferring the
 * shortest unambiguous path: the same folder first, then anywhere in the vault.
 * These tests apply that rule to what `exportVault` actually writes.
 */

let ws: Workspace;

beforeEach(async () => {
  ws = new Workspace(memoryStorage());
  await ws.load();
});

/** Every `[[wikilink]]` in a vault, with the file it appears in. */
function wikilinks(files: Array<{ path: string; text?: string }>): Array<{ from: string; target: string }> {
  const found: Array<{ from: string; target: string }> = [];
  for (const file of files) {
    for (const match of (file.text ?? '').matchAll(/\[\[([^\]]+)\]\]/g)) {
      found.push({ from: file.path, target: match[1]!.split('|')[0]!.split('#')[0]!.trim() });
    }
  }
  return found;
}

/** Obsidian's rule: same folder first, then anywhere. */
function resolves(target: string, from: string, paths: string[]): boolean {
  const folder = from.slice(0, from.lastIndexOf('/') + 1);
  if (paths.includes(`${folder}${target}.md`)) return true;
  return paths.some((path) => path.endsWith(`/${target}.md`) || path === `${target}.md`);
}

describe('every link in an exported vault resolves', () => {
  it('a sub-page reference points at a file that exists', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    await ws.createPage({ parentId: parent, title: 'Éditeur' });

    const files = exportVault(ws);
    const paths = files.map((f) => f.path);
    const links = wikilinks(files);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(resolves(link.target, link.from, paths), `${link.target} depuis ${link.from}`).toBe(true);
    }
  });

  it('holds three levels down, where the folder rule matters most', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    await ws.createPage({ parentId: b, title: 'C' });

    const files = exportVault(ws);
    const paths = files.map((f) => f.path);
    for (const link of wikilinks(files)) {
      expect(resolves(link.target, link.from, paths), `${link.target} depuis ${link.from}`).toBe(true);
    }
  });

  it('a link to a page elsewhere in the vault resolves too', async () => {
    const a = await ws.createPage({ title: 'Source' });
    const b = await ws.createPage({ title: 'Cible' });
    const doc = ws.document(a)!;
    doc.children!.push({ id: uuidv7(), type: 'link_to_page', version: 1, props: { pageId: b, title: 'Cible' } });
    await ws.save(a, doc);

    const files = exportVault(ws);
    const paths = files.map((f) => f.path);
    const links = wikilinks(files);
    expect(links.some((l) => l.target === 'Cible')).toBe(true);
    for (const link of links) {
      expect(resolves(link.target, link.from, paths)).toBe(true);
    }
  });

  it('a title that needs sanitising still resolves to its file', async () => {
    // the filename is slugified; a wikilink naming the *title* would dangle
    const parent = await ws.createPage({ title: 'Notes' });
    await ws.createPage({ parentId: parent, title: 'Réunion : 2026/07' });

    const files = exportVault(ws);
    const paths = files.map((f) => f.path);
    for (const link of wikilinks(files)) {
      expect(resolves(link.target, link.from, paths), `${link.target} depuis ${link.from}`).toBe(true);
    }
  });
});

describe('the parts Obsidian is meant to ignore', () => {
  it('nothing is written into a dot-directory by the vault export', () => {
    // `.nbe/` holds the canonical JSON and Obsidian skips dot-folders, but the
    // *vault* itself must contain no hidden files of its own
    const files = exportVault(ws);
    expect(files.filter((file) => file.path.split('/').some((part) => part.startsWith('.')))).toEqual([]);
  });

  it('frontmatter is YAML Obsidian can show as properties', async () => {
    await ws.createPage({ title: 'Une page' });
    const [file] = exportVault(ws);
    const lines = (file!.text ?? '').split('\n');
    expect(lines[0]).toBe('---');
    // key: value pairs only — a block of JSON here would show as broken
    const end = lines.indexOf('---', 1);
    for (const line of lines.slice(1, end)) {
      expect(line).toMatch(/^[a-z_]+: .+$/);
    }
  });
});
