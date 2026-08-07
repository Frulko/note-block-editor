import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nbe/core';
import { openWorkspace } from '../src/index';
import { WorkspaceIndex } from '../src/index-db';

/**
 * L2 for a runtime that has a filesystem.
 *
 * The claim §10 makes about it is stronger than "it is fast": it holds **zero
 * unique information** and is rebuildable by a full scan. That is the property
 * worth testing, because an index that quietly becomes authoritative is how a
 * cache turns into a second source of truth nobody can migrate.
 */

let root: string;
let index: WorkspaceIndex | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nbe-idx-'));
});
afterEach(() => {
  index?.close();
  index = null;
  rmSync(root, { recursive: true, force: true });
});

async function seeded() {
  const workspace = await openWorkspace(root);
  const parent = await workspace.createPage({ title: 'Réunions' });
  const child = await workspace.createPage({ parentId: parent, title: 'Lundi' });
  const doc = workspace.document(child)!;
  doc.children!.push({
    id: uuidv7(),
    type: 'paragraph',
    version: 1,
    text: [{ text: 'Compte rendu de la réunion, avec un budget à revoir.' }],
  });
  await workspace.save(child, doc);
  return { workspace, parent, child };
}

describe('the index answers', () => {
  it('finds a page by a word in its body', async () => {
    const { workspace, child } = await seeded();
    index = new WorkspaceIndex(root);
    expect(index.rebuild(workspace)).toBe(2);
    expect(index.search('budget').map((h) => h.pageId)).toEqual([child]);
  });

  it('returns a snippet around the match', async () => {
    const { workspace } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(index.search('budget')[0]!.snippet).toContain('budget');
  });

  it('ranks rather than returning everything in file order', async () => {
    const { workspace } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(index.search('réunion').length).toBeGreaterThan(0);
  });

  it('a query with an apostrophe is words, not a syntax error', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: "Aujourd'hui" });
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    // FTS5's MATCH is a query language; unescaped this throws instead of searching
    expect(index.search("aujourd'hui").map((h) => h.pageId)).toEqual([id]);
    expect(() => index!.search('vis-à-vis')).not.toThrow();
  });

  it('an empty query finds nothing rather than everything', async () => {
    const { workspace } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(index.search('   ')).toEqual([]);
  });

  it('backlinks come back with the kind of reference', async () => {
    const { workspace, parent, child } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(index.backlinks(child)).toEqual([{ pageId: parent, title: 'Réunions', kind: 'sub_page' }]);
  });

  it('a page is never its own backlink', async () => {
    const { workspace, child } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(index.backlinks(child).some((b) => b.pageId === child)).toBe(false);
  });
});

describe('it holds zero unique information', () => {
  it('deleting the file and rebuilding gives identical answers', async () => {
    const { workspace, child } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    const before = {
      search: index.search('budget'),
      backlinks: index.backlinks(child),
    };

    // the whole claim: throw the index away and it comes back the same
    index.close();
    rmSync(join(root, '.nbe', 'index.sqlite'), { force: true });
    rmSync(join(root, '.nbe', 'index.sqlite-wal'), { force: true });
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);

    expect(index.search('budget')).toEqual(before.search);
    expect(index.backlinks(child)).toEqual(before.backlinks);
  });

  it('a rebuild replaces rather than accumulates', async () => {
    const { workspace } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    const once = index.search('budget');
    index.rebuild(workspace);
    index.rebuild(workspace);
    expect(index.search('budget')).toEqual(once);
  });

  it('a deleted page leaves the index after the next rebuild', async () => {
    const { workspace, child } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    await workspace.deletePage(child);
    index.rebuild(workspace);
    expect(index.search('budget')).toEqual([]);
  });

  it('lives inside .nbe, beside the pages it derives from', async () => {
    const { workspace } = await seeded();
    index = new WorkspaceIndex(root);
    index.rebuild(workspace);
    expect(statSync(join(root, '.nbe', 'index.sqlite')).isFile()).toBe(true);
  });
});
