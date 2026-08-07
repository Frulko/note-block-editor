import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
