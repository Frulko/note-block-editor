import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWorkspace, writeVault } from '../src/index';
import { snapshot, watchVault } from '../src/watch';

/**
 * Editing the vault in another program, and having the workspace notice.
 *
 * This is the payoff of file-over-app, so the cases that matter are the ones
 * where an editor behaves in its own way: writing via a temp file, touching a
 * file without changing it, or removing one mid-save.
 */

let root: string;
let stop: (() => void) | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nbe-watch-'));
});
afterEach(() => {
  stop?.();
  stop = null;
  rmSync(root, { recursive: true, force: true });
});

/** Let the watcher tick a few times. */
const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the snapshot describes content, not timestamps', () => {
  it('is empty when there is no vault yet', () => {
    expect(snapshot(join(root, 'vault')).size).toBe(0);
  });

  it('changes only when the bytes change', async () => {
    const workspace = await openWorkspace(root);
    await workspace.createPage({ title: 'Page' });
    writeVault(workspace, root);
    const vault = join(root, 'vault');

    const before = snapshot(vault);
    // a save that rewrites identical content, which many editors do
    const file = join(vault, 'Page.md');
    writeFileSync(file, readFileSync(file, 'utf8'));
    expect(snapshot(vault)).toEqual(before);

    writeFileSync(file, readFileSync(file, 'utf8') + '\nUne ligne de plus.\n');
    expect(snapshot(vault)).not.toEqual(before);
  });
});

describe('an edit made elsewhere reaches the workspace', () => {
  it('imports the change, keeping the page id', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Journal' });
    writeVault(workspace, root);

    const seen: number[] = [];
    stop = watchVault(workspace, root, { intervalMs: 40, onImport: (_, pages) => seen.push(pages) });

    const file = join(root, 'vault', 'Journal.md');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nÉcrit dans Obsidian.\n');
    await settle();

    expect(seen.length).toBeGreaterThan(0);
    expect(workspace.node(id)).toBeDefined(); // the id survived, not a new page
    expect(workspace.search('Obsidian')).toHaveLength(1);
  });

  it('does not rewrite the file the user is editing', async () => {
    const workspace = await openWorkspace(root);
    await workspace.createPage({ title: 'Journal' });
    writeVault(workspace, root);
    stop = watchVault(workspace, root, { intervalMs: 40 });

    const file = join(root, 'vault', 'Journal.md');
    // hand-wrapped the way a person writes, which a sync would fold away
    const written = readFileSync(file, 'utf8') + '\nUne phrase\nqui continue.\n';
    writeFileSync(file, written);
    await settle();

    expect(readFileSync(file, 'utf8')).toBe(written);
  });

  it('moving a file into a folder re-parents the page', async () => {
    const workspace = await openWorkspace(root);
    const parent = await workspace.createPage({ title: 'Parent' });
    const child = await workspace.createPage({ title: 'Enfant' });
    writeVault(workspace, root);
    expect(workspace.node(child)!.parentId).toBeNull();

    stop = watchVault(workspace, root, { intervalMs: 40 });
    // what a person does in Finder: drag the file into the parent's folder,
    // and add the link the parent's body needs
    const vault = join(root, 'vault');
    const body = readFileSync(join(vault, 'Enfant.md'), 'utf8');
    rmSync(join(vault, 'Enfant.md'));
    writeFileSync(join(vault, 'Parent.md'), readFileSync(join(vault, 'Parent.md'), 'utf8') + '\n[[Enfant]]\n');
    mkdirSync(join(vault, 'Parent'), { recursive: true });
    writeFileSync(join(vault, 'Parent', 'Enfant.md'), body);
    await settle(300);

    expect(workspace.node(child)!.parentId).toBe(parent);
  });

  it('a file that disappears is reported, and its page is kept', async () => {
    const workspace = await openWorkspace(root);
    const id = await workspace.createPage({ title: 'Fragile' });
    writeVault(workspace, root);

    const missing: string[] = [];
    stop = watchVault(workspace, root, { intervalMs: 40, onMissing: (paths) => missing.push(...paths) });
    rmSync(join(root, 'vault', 'Fragile.md'));
    await settle();

    expect(missing).toContain('Fragile.md');
    // losing a page to a mid-save vanish is not recoverable from the vault
    expect(workspace.node(id)).toBeDefined();
  });
});
