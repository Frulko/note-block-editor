import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, expect } from './fixtures';

/**
 * The vault export, checked by the operating system.
 *
 * @remarks
 * §10's promise is that a deleted app leaves a readable workspace. A test that
 * only inspects the bytes we produced proves nothing about that — so this
 * downloads the archive and unzips it with the system `unzip`, which validates
 * every CRC and refuses a malformed central directory. If the hand-written ZIP
 * encoder in `examples/vanilla/src/zip.ts` is wrong, this fails.
 */

/** Download the vault and unzip it into a temporary directory. */
async function downloadVault(page: import('@playwright/test').Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-vault').click(),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'nbe-vault-'));
  const archive = join(dir, 'vault.zip');
  await download.saveAs(archive);
  /*
   * Two independent readers, because agreeing with ourselves proves nothing.
   * Info-ZIP's `unzip -t` validates every CRC and the central directory;
   * Python's `zipfile` extracts, and unlike the Info-ZIP 6.00 that macOS still
   * ships (2009) it honours the UTF-8 filename flag, so accented titles come
   * out intact rather than transliterated into mojibake.
   */
  execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });
  const out = join(dir, 'out');
  execFileSync('python3', ['-m', 'zipfile', '-e', archive, out], { stdio: 'pipe' });
  return out;
}

/** Every file in the unzipped vault, as paths relative to its root. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

test.describe('a workspace leaves as a folder of Markdown', () => {
  let vault: string | null = null;

  test.afterEach(() => {
    if (vault) rmSync(join(vault, '..'), { recursive: true, force: true });
    vault = null;
  });

  test('the archive is valid, and holds one .md per page', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(250);
    vault = await downloadVault(page);
    const files = tree(vault);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.md$/);
  });

  test('the hierarchy is folders, so a reader sees it without parsing', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(250);
    const row = page.locator('.page-item').first();
    await row.hover();
    await row.locator('.page-add').click();
    await page.waitForTimeout(400);

    vault = await downloadVault(page);
    const files = tree(vault);
    expect(files).toHaveLength(2);
    // the child's path is nested under a folder named after its parent
    const child = files.find((f) => f.includes('/'))!;
    const parent = files.find((f) => !f.includes('/'))!;
    expect(child.startsWith(parent.replace(/\.md$/, '/'))).toBe(true);
  });

  test('a page reads as Markdown, with its id preserved', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(250);
    vault = await downloadVault(page);
    const text = readFileSync(join(vault, tree(vault)[0]!), 'utf8');

    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toMatch(/^id: [0-9a-f-]+$/m);
    expect(text).toContain('# ');
    // the whole point: no JSON blob, no HTML wrapper
    expect(text).not.toContain('"type":');
    expect(text).not.toContain('<div');
  });

  test('accented titles survive the archive', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(250);
    vault = await downloadVault(page);
    // the demo's page is "L'éditeur de blocs" — a UTF-8 name in a ZIP is only
    // correct if the general-purpose flag says so
    expect(tree(vault)[0]).toContain('éditeur');
  });
});

/** Build a zip from a set of files, using the system zipper. */
function makeArchive(files: Array<{ path: string; text: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nbe-src-'));
  for (const file of files) {
    const full = join(dir, file.path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, file.text);
  }
  const archive = join(dir, '..', `${dir.split('/').pop()}.zip`);
  execFileSync('zip', ['-r', '-q', archive, '.'], { cwd: dir });
  return archive;
}

test.describe('an archive comes back in', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(300);
  });

  test('our own export re-imports onto the same pages, not beside them', async ({ page }) => {
    const before = await page.locator('.page-item').count();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-vault').click(),
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'nbe-rt-'));
    const archive = join(dir, 'ours.zip');
    await download.saveAs(archive);

    await page.locator('#import-file').setInputFiles(archive);
    await page.waitForTimeout(900);
    // ids are preserved, so this updates rather than duplicates
    expect(await page.locator('.page-item').count()).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a Notion export arrives with its tree, titles and callouts', async ({ page }) => {
    // named the way Notion names things (docs/research/notion-editor.md)
    const hexA = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
    const hexB = '11112222333344445555666666666666';
    const archive = makeArchive([
      { path: `Projet ${hexA}.md`, text: '# Projet\n\n> 💡 Une note importée\n' },
      { path: `Projet ${hexA}/Sous-page ${hexB}.md`, text: '# Sous-page\n\nContenu Notion.\n' },
    ]);

    await page.locator('#import-file').setInputFiles(archive);
    await page.waitForTimeout(900);

    const labels = await page.locator('.page-item-label').allTextContents();
    expect(labels.some((l) => l.includes('Projet'))).toBe(true);
    expect(labels.some((l) => l.includes('Sous-page'))).toBe(true);

    await page.locator('.page-item').filter({ hasText: 'Projet' }).first().click();
    await page.waitForTimeout(400);
    // the emoji blockquote is a callout again, not a quote
    await expect(page.locator('.nbe-t-callout')).toHaveCount(1);
    await expect(page.locator('.nbe-t-quote')).toHaveCount(0);
    expect(await page.locator('.nbe-editor').textContent()).toContain('Une note importée');
  });

  test('the imported tree is nested, not flat', async ({ page }) => {
    const hexA = 'ffffffffbbbbccccddddeeeeeeeeeeee';
    const hexB = '99998888777766665555444444444444';
    const archive = makeArchive([
      { path: `Racine ${hexA}.md`, text: '# Racine\n\ntexte' },
      { path: `Racine ${hexA}/Enfant ${hexB}.md`, text: '# Enfant\n\ntexte' },
    ]);
    await page.locator('#import-file').setInputFiles(archive);
    await page.waitForTimeout(900);

    const indents = await page.evaluate(() =>
      [...document.querySelectorAll('.page-item')].map((el) => (el as HTMLElement).style.paddingInlineStart),
    );
    expect(indents).toContain('22px');
  });
});
