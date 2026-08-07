import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type BlockJSON } from '@nbe/core';
import { SUB_PAGE, Workspace, memoryStorage } from '../src/index';
import { exportVault, importVault, slugify, vaultPathFor } from '../src/vault';

/**
 * "Delete the app, read the files" — checked, not asserted in prose.
 *
 * The acceptance test §10 describes becomes CI in phase 4b, where files are
 * real. What is checkable now is the projection itself: that a workspace
 * becomes a readable vault, and that the vault becomes the same workspace.
 */

let ws: Workspace;

beforeEach(async () => {
  ws = new Workspace(memoryStorage());
  await ws.load();
});

/** Give a page some prose so the export has something to project. */
async function write(id: string, text: string) {
  const doc = ws.document(id)!;
  doc.children!.push({ id: uuidv7(), type: 'paragraph', version: 1, text: [{ text }] });
  await ws.save(id, doc);
}

const pathsOf = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe('the layout is a vault a person can read', () => {
  it('one markdown file per page', async () => {
    await ws.createPage({ title: 'Journal' });
    await ws.createPage({ title: 'Recettes' });
    expect(pathsOf(exportVault(ws))).toEqual(['Journal.md', 'Recettes.md']);
  });

  it('children live in a folder named after their parent', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    await ws.createPage({ parentId: parent, title: 'Éditeur' });
    expect(pathsOf(exportVault(ws))).toEqual(['Projets.md', 'Projets/Éditeur.md']);
  });

  it('nests as deep as the tree goes', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    await ws.createPage({ parentId: b, title: 'C' });
    expect(pathsOf(exportVault(ws))).toEqual(['A.md', 'A/B.md', 'A/B/C.md']);
  });

  it('carries the id in frontmatter, so anchors and links survive a text editor', async () => {
    const id = await ws.createPage({ title: 'Journal' });
    const [file] = exportVault(ws);
    expect(file!.text).toContain(`id: ${id}`);
    expect(file!.text).toContain('title: "Journal"');
  });

  it('writes the body as plain markdown, with no JSON and no HTML', async () => {
    const id = await ws.createPage({ title: 'Notes' });
    const doc = ws.document(id)!;
    doc.children!.push({
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      text: [{ text: 'Du texte ' }, { text: 'en gras', marks: [{ type: 'bold' }] }, { text: '.' }],
    });
    await ws.save(id, doc);
    const [file] = exportVault(ws);
    const body = file!.text.split('---\n')[2]!;
    expect(body).toContain('Du texte **en gras**.');
    expect(body).not.toContain('{');
    expect(body).not.toContain('<');
  });

  it('names a page whose title would break a filesystem', () => {
    expect(slugify('Notes 2026/07 : réunion ?')).toBe('Notes 2026 07 réunion');
    expect(slugify('   ')).toBe('sans-titre');
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('can say where a page will land', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Éditeur' });
    expect(vaultPathFor(ws, child)).toBe('Projets/Éditeur.md');
    expect(vaultPathFor(ws, 'absent')).toBeNull();
  });
});

describe('a vault reads back as the same workspace', () => {
  /** Export, import, and load the result into a fresh workspace. */
  async function roundTrip(source: Workspace): Promise<Workspace> {
    const pages = importVault(exportVault(source));
    const store = memoryStorage(Object.fromEntries(pages.map((p) => [p.id, p])));
    const back = new Workspace(store);
    await back.load();
    return back;
  }

  it('keeps every page, and every id', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ title: 'B' });
    const back = await roundTrip(ws);
    expect([...back.roots].sort()).toEqual([a, b].sort());
  });

  it('rebuilds the tree from the folders', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Éditeur' });
    const back = await roundTrip(ws);
    expect(back.roots).toEqual([parent]);
    expect(back.node(parent)!.children).toEqual([child]);
    expect(back.node(child)!.title).toBe('Éditeur');
  });

  it('rebuilds three levels', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    const c = await ws.createPage({ parentId: b, title: 'C' });
    const back = await roundTrip(ws);
    expect(back.path(c).map((n) => n.id)).toEqual([a, b, c]);
  });

  it('keeps the prose', async () => {
    const id = await ws.createPage({ title: 'Notes' });
    await write(id, 'Une phrase qui doit survivre.');
    const back = await roundTrip(ws);
    expect(back.search('survivre')).toHaveLength(1);
  });

  it('a wikilink outside the folder stays a link, not a sub-page', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ title: 'B' });
    const doc = ws.document(a)!;
    doc.children!.push({ id: uuidv7(), type: 'link_to_page', version: 1, props: { pageId: b, title: 'B' } });
    await ws.save(a, doc);

    const back = await roundTrip(ws);
    // B is a root beside A, not nested under it — the rule is "a wikilink whose
    // target is a file in *this page's folder*", and B's file is not
    expect([...back.roots].sort()).toEqual([a, b].sort());
    expect(back.node(a)!.children).toEqual([]);
  });

  it('is stable after the first normalisation', async () => {
    // not equal to the *first* export: a page starts with an empty paragraph
    // and markdown has no way to write one, so it is dropped on the way back.
    // The property that matters is the same one the docs round trip uses —
    // export → import may change things once, and never again.
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Éditeur' });
    await write(child, 'Contenu.');

    const once = await roundTrip(ws);
    const twice = await roundTrip(once);
    expect(exportVault(twice)).toEqual(exportVault(once));
  });

  it('an empty block is the documented loss, and it is only that', async () => {
    const id = await ws.createPage({ title: 'Notes' });
    await write(id, 'Du contenu.');
    const before = exportVault(ws);
    const after = exportVault(await roundTrip(ws));
    expect(after.map((f) => f.path)).toEqual(before.map((f) => f.path));
    // every non-blank line survives; only empty ones go
    const lines = (text: string) => text.split('\n').filter((l) => l.trim());
    expect(lines(after[0]!.text)).toEqual(lines(before[0]!.text));
  });
});

describe('a vault a person edited by hand', () => {
  const file = (path: string, text: string) => ({ path, text });

  it('accepts a file with no frontmatter and gives it an id', () => {
    const [page] = importVault([file('Notes.md', '# Notes\n\nÉcrit à la main.')]);
    expect(page!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page!.props!['title']).toBe('Notes');
  });

  it('takes the title from the filename when frontmatter has none', () => {
    const [page] = importVault([file('Sous-dossier/Ma page.md', 'du texte')]);
    expect(page!.props!['title']).toBe('Ma page');
  });

  it('re-parents a page that was moved into a folder in Obsidian', () => {
    // the point of file-over-app: moving the file *is* moving the page
    const pages = importVault([
      file('Parent.md', '---\nid: p\ntitle: "Parent"\n---\n\n[[Enfant]]'),
      file('Parent/Enfant.md', '---\nid: c\ntitle: "Enfant"\n---\n\ndu texte'),
    ]);
    const parent = pages.find((p) => p.id === 'p')!;
    const ref = (parent.children ?? []).find((b) => b.type === SUB_PAGE);
    expect(ref?.props?.['pageId']).toBe('c');
  });

  it('leaves a wikilink pointing at nothing as an ordinary link', () => {
    const [page] = importVault([file('Notes.md', '[[Page inexistante]]')]);
    const kinds = (page!.children ?? []).map((b: BlockJSON) => b.type);
    expect(kinds).toContain('link_to_page');
    expect(kinds).not.toContain(SUB_PAGE);
  });

  it('ignores files that are not markdown', () => {
    expect(importVault([file('image.png', 'binaire'), file('Notes.md', 'ok')])).toHaveLength(1);
  });

  it('a folder with no page file of its own is just a folder', () => {
    const pages = importVault([file('Dossier/Une note.md', 'du texte')]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.props!['title']).toBe('Une note');
  });
});
