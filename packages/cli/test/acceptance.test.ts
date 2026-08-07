import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nbe/core';
import { checkReadable, importDirectory, openWorkspace, writeVault } from '../src/index';
import { fileStorage } from '../src/storage';

/**
 * §10's acceptance test, run by a machine.
 *
 * > "with the app deleted, the workspace folder opened in a text editor shows
 * > every page, row, view definition, and asset. Content that exists only in
 * > the derived index — or only inside a binary blob — is a bug."
 *
 * Until phase 4b there was no runtime where files were real enough to check
 * that. This is it.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nbe-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run the CLI the way a user would, and return its output. */
function nbe(...args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('pnpm', ['exec', 'tsx', join(import.meta.dirname, '..', 'src', 'bin.ts'), '--root', root, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

describe('pages are real files, written safely', () => {
  it('one JSON file per page, under .nbe', async () => {
    const workspace = await openWorkspace(root);
    await workspace.createPage({ title: 'Journal' });
    expect(readdirSync(join(root, '.nbe')).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('a write leaves no temporary file behind', async () => {
    const workspace = await openWorkspace(root);
    await workspace.createPage({ title: 'Journal' });
    expect(readdirSync(join(root, '.nbe')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('a reader never sees a half-written page', async () => {
    // the guarantee rename gives: the target is either the old bytes or the
    // new ones. Simulated by checking every intermediate read parses.
    const storage = fileStorage(root);
    const page = { id: 'p1', type: 'page', version: 1, children: [] };
    await storage.write('p1', page);
    for (let i = 0; i < 20; i++) {
      await storage.write('p1', { ...page, props: { title: 'x'.repeat(i * 500) } });
      expect(await storage.read('p1')).not.toBeNull();
    }
  });

  it('refuses a page id that would escape the directory', async () => {
    const storage = fileStorage(root);
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/unsafe/);
  });

  it('a missing page reads as null rather than throwing', async () => {
    expect(await fileStorage(root).read('absent')).toBeNull();
  });

  it('survives being reopened, because nothing lives in memory', async () => {
    const first = await openWorkspace(root);
    const parent = await first.createPage({ title: 'Projets' });
    const child = await first.createPage({ parentId: parent, title: 'Éditeur' });

    const second = await openWorkspace(root);
    expect(second.roots).toEqual([parent]);
    expect(second.node(parent)!.children).toEqual([child]);
  });
});

describe('delete the app, read the files', () => {
  it('every page is in the vault as Markdown, with its id', async () => {
    const workspace = await openWorkspace(root);
    const parent = await workspace.createPage({ title: 'Projets' });
    await workspace.createPage({ parentId: parent, title: 'Éditeur' });
    writeVault(workspace, root);

    expect(checkReadable(workspace, root)).toEqual([]);
  });

  it('says exactly what is wrong when a page is missing from the vault', async () => {
    const workspace = await openWorkspace(root);
    await workspace.createPage({ title: 'Présente' });
    writeVault(workspace, root);
    // a page created after the last sync
    await workspace.createPage({ title: 'Oubliée' });

    const problems = checkReadable(workspace, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Oubliée');
  });

  it('refuses a vault that smuggles the model back in as JSON', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Page' });
    writeVault(workspace, root);
    const file = join(root, 'vault', 'Page.md');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n{"type": "paragraph"}\n');

    expect(checkReadable(workspace, root).join(' ')).toContain('JSON blob');
    expect(id).toBeTruthy();
  });

  it('notices an asset that is referenced but not written', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Album' });
    const doc = workspace.document(id)!;
    doc.children!.push({ id: uuidv7(), type: 'image', version: 1, props: { src: 'asset:deadbeef' } });
    await workspace.save(id, doc);
    writeVault(workspace, root); // no assets supplied

    expect(checkReadable(workspace, root).join(' ')).toContain('deadbeef');
  });

  it('passes once the asset travels with it', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Album' });
    const doc = workspace.document(id)!;
    doc.children!.push({ id: uuidv7(), type: 'image', version: 1, props: { src: 'asset:deadbeef' } });
    await workspace.save(id, doc);
    writeVault(workspace, root, new Map([['asset:deadbeef', new Uint8Array([1, 2, 3])]]));

    expect(checkReadable(workspace, root)).toEqual([]);
  });
});

describe('the vault is a projection, rebuilt not patched', () => {
  it('a renamed page leaves no stale file behind', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Ancien nom' });
    writeVault(workspace, root);
    await workspace.renamePage(id, 'Nouveau nom');
    writeVault(workspace, root);

    const files = readdirSync(join(root, 'vault'));
    expect(files).toEqual(['Nouveau nom.md']);
  });

  it('imports a vault a person edited by hand', async () => {
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'Notes.md'), '---\nid: note-1\ntitle: "Notes"\n---\n\n# Notes\n\nÉcrit à la main.\n');

    const workspace = await openWorkspace(root);
    expect(await importDirectory(workspace, source)).toBe(1);
    expect(workspace.search('main')).toHaveLength(1);
  });
});

describe('the command line', () => {
  it('prints usage and exits cleanly', () => {
    const { code, out } = nbe('help');
    expect(code).toBe(0);
    expect(out).toContain('nbe check');
  });

  it('creates a page, lists it, and reads it back as Markdown', () => {
    const created = nbe('new', 'Ma page');
    expect(created.code).toBe(0);
    const id = created.out.trim();

    expect(nbe('ls').out).toContain('Ma page');
    expect(nbe('cat', id).out).toContain('# Ma page');
  });

  it('check passes on a synced workspace and fails on a stale one', () => {
    nbe('new', 'Une page');
    expect(nbe('check').code).toBe(0);

    rmSync(join(root, 'vault'), { recursive: true, force: true });
    const stale = nbe('check');
    expect(stale.code).toBe(1);
    expect(stale.err).toContain('nbe sync');
  });

  it('search reports a miss with a non-zero status, so a script can branch', () => {
    nbe('new', 'Une page');
    expect(nbe('search', 'page').code).toBe(0);
    expect(nbe('search', 'introuvable-zzz').code).toBe(1);
  });

  it('an unknown command explains itself rather than crashing', () => {
    const { code, err } = nbe('frobnicate');
    expect(code).toBe(2);
    expect(err).toContain('commande inconnue');
  });
});

describe('search and backlinks from the command line', () => {
  it('search finds a word in a page body, ranked by the index', () => {
    nbe('new', 'Réunion de lundi');
    const found = nbe('search', 'lundi');
    expect(found.code).toBe(0);
    expect(found.out).toContain('Réunion de lundi');
  });

  it('a query with an apostrophe searches rather than erroring', () => {
    nbe('new', "Aujourd'hui");
    const found = nbe('search', "aujourd'hui");
    expect(found.code).toBe(0);
    expect(found.err).toBe('');
  });

  it('backlinks names what points at a page, and why', () => {
    const parent = nbe('new', 'Parent').out.trim();
    const child = nbe('new', 'Enfant', '--parent', parent).out.trim();
    const links = nbe('backlinks', child);
    expect(links.code).toBe(0);
    expect(links.out).toContain('sub_page');
    expect(links.out).toContain('Parent');
  });

  it('the index is derived: deleting it changes no answer', () => {
    nbe('new', 'Réunion de lundi');
    const before = nbe('search', 'lundi').out;
    rmSync(join(root, '.nbe', 'index.sqlite'), { force: true });
    expect(nbe('search', 'lundi').out).toBe(before);
  });
});

describe('two writers do not race', () => {
  it('a second writer is refused while the first holds the workspace', () => {
    // a lock left by a live process: this one
    mkdirSync(join(root, '.nbe'), { recursive: true });
    writeFileSync(join(root, '.nbe', 'lock'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

    const refused = nbe('new', 'Pendant ce temps');
    // exit 3, not 2: being busy is a normal outcome a script can retry on
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('utilisé par le processus');
  });

  it('reading is never blocked by a writer', () => {
    rmSync(join(root, '.nbe', 'lock'), { force: true });
    nbe('new', 'Une page');
    mkdirSync(join(root, '.nbe'), { recursive: true });
    writeFileSync(join(root, '.nbe', 'lock'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

    // ls sees the old page or the new one, never a torn one — no reason to fail
    expect(nbe('ls').code).toBe(0);
    expect(nbe('ls').out).toContain('Une page');
  });

  it('a crashed writer does not lock the workspace forever', () => {
    rmSync(join(root, '.nbe', 'lock'), { force: true });
    mkdirSync(join(root, '.nbe'), { recursive: true });
    writeFileSync(
      join(root, '.nbe', 'lock'),
      JSON.stringify({ pid: 0x7ffffffe, at: Date.now() - 60_000 }),
      'utf8',
    );
    expect(nbe('new', 'Après le crash').code).toBe(0);
  });
});
