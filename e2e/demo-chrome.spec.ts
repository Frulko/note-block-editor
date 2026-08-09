import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';

/**
 * The topbar's own affordances: per-page export and the theme switch.
 *
 * @remarks
 * The vault export is proven by `vault.spec.ts` with the operating system as
 * witness; these two exports are single files, so reading the bytes back is
 * the whole check. The theme is one attribute on `<html>` — what matters is
 * that it reaches both the demo chrome and the editor, and that it survives a
 * reload.
 */

async function downloadedText(page: import('@playwright/test').Page, button: string): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(button).click(),
  ]);
  return { name: download.suggestedFilename(), text: readFileSync((await download.path())!, 'utf8') };
}

test('the open page exports as JSON and as Markdown', async ({ page, editor }) => {
  const json = await downloadedText(page, '#export-json');
  expect(json.name).toMatch(/\.json$/);
  const doc = JSON.parse(json.text) as { type: string; children: unknown[] };
  expect(doc.type).toBe('page');
  expect(doc.children.length).toBeGreaterThan(0);

  const md = await downloadedText(page, '#export-md');
  expect(md.name).toMatch(/\.md$/);
  expect(md.text).toContain("# L'éditeur de blocs");

  expect(editor.errors()).toEqual([]);
});

test('the theme select forces a side and survives a reload', async ({ page, editor }) => {
  const html = page.locator('html');
  await page.locator('#theme').selectOption('dark');
  await expect(html).toHaveAttribute('data-nbe-theme', 'dark');
  // the attribute is the editor's documented host hook — check it actually lands there
  await expect(page.locator('.nbe-editor')).toHaveCSS('color-scheme', 'dark');

  await page.reload();
  await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
  await expect(html).toHaveAttribute('data-nbe-theme', 'dark');

  await page.locator('#theme').selectOption('');
  await expect(html).not.toHaveAttribute('data-nbe-theme');
  expect(editor.errors()).toEqual([]);
});

/**
 * A menu has to look like a menu: an edge of its own, groups you can tell
 * apart, and a row that says it is under the pointer.
 *
 * The panel had a shadow and no border, and a host whose panels are the colour
 * of the page — Obsidian maps `--nbe-surface` to `--background-primary` —
 * left nothing between it and what is under it.
 */
test.describe('the floating menu reads as one', () => {
  test('the panel has an edge, and a section is ruled off from the rows above it', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un paragraphe']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    const menu = page.locator('.nbe-menu').first();
    await expect(menu).toBeVisible();

    const edge = await menu.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(edge).not.toBe('0px');

    const rules = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.nbe-menu-section')].map((el) => ({
        afterRow: !!el.previousElementSibling,
        border: getComputedStyle(el).borderTopWidth,
      })),
    );
    // a heading that follows content is ruled off from it…
    expect(rules.filter((r) => r.afterRow).length).toBeGreaterThan(0);
    expect(rules.filter((r) => r.afterRow).every((r) => r.border !== '0px')).toBe(true);
    // …and one with nothing above it has nothing to be separated from
    expect(rules.filter((r) => !r.afterRow).every((r) => r.border === '0px')).toBe(true);
  });

  test('the hovered row is visibly the hovered row', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('/');
    const item = page.locator('.nbe-menu-item').nth(2);
    const plain = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
    await item.hover();
    const hovered = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(hovered).not.toBe(plain);
  });
});
