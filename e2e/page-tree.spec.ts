import { test, expect } from './fixtures';

/**
 * ROADMAP phase 4 — the notes app, seen from the app.
 *
 * @remarks
 * `packages/workspace` proves the model headlessly. This proves the wiring:
 * that the sidebar shows a real tree, that a sub-page is created by the right
 * writer, and that the tree survives a reload — which it can only do if it is
 * genuinely derived from the documents, since nothing else is persisted.
 */

/** Sidebar rows as `depth:title`, depth read from the indent the tree applies. */
async function rows(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.page-item')].map((el) => {
      const indent = parseInt((el as HTMLElement).style.paddingInlineStart || '8', 10);
      const label = el.querySelector('.page-item-label')?.textContent ?? '';
      return `${(indent - 8) / 14}:${label.replace(/^\S+\s/, '')}`;
    }),
  );
}

/** Add a sub-page under the row at `index`. */
async function addChild(page: import('@playwright/test').Page, index: number) {
  const row = page.locator('.page-item').nth(index);
  await row.hover();
  await row.locator('.page-add').click();
  await page.waitForTimeout(400);
}

test.describe('the sidebar is a page tree', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(250);
  });

  test('a fresh workspace has one root page', async ({ page }) => {
    expect(await rows(page)).toEqual(["0:L'éditeur de blocs"]);
  });

  test('adding a sub-page nests it under its parent', async ({ page }) => {
    await addChild(page, 0);
    const after = await rows(page);
    expect(after).toHaveLength(2);
    expect(after[0]!.startsWith('0:')).toBe(true);
    expect(after[1]!.startsWith('1:')).toBe(true);
  });

  test('the parent shows it has children', async ({ page }) => {
    await addChild(page, 0);
    const label = await page.locator('.page-item-label').first().textContent();
    expect(label).toContain('📂');
  });

  test('it nests to a third level', async ({ page }) => {
    await addChild(page, 0);
    await addChild(page, 1);
    const after = await rows(page);
    expect(after.map((r) => r.split(':')[0])).toEqual(['0', '1', '2']);
  });

  test('the sub-page is a block in the parent document, not a stored field', async ({ page }) => {
    await addChild(page, 0);
    const parentBlocks = await page.evaluate(() => {
      const ws = JSON.parse(localStorage.getItem('nbe-workspace-v1') ?? '{}');
      return (ws.pages?.[0]?.children ?? []).map((b: { type: string }) => b.type);
    });
    // this is the invariant the whole model rests on: the tree is derived from
    // these blocks, so a workspace with no index still has a tree
    expect(parentBlocks).toContain('sub_page');
  });

  test('the tree survives a reload, because nothing else stores it', async ({ page }) => {
    await addChild(page, 0);
    const before = await rows(page);
    await page.reload();
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(300);
    expect(await rows(page)).toEqual(before);
  });

  test('opening a sub-page keeps the tree visible', async ({ page, editor }) => {
    await addChild(page, 0);
    await page.locator('.page-item').nth(1).click();
    await page.waitForTimeout(300);
    expect(await rows(page)).toHaveLength(2);
    expect(await page.locator('.page-item.active').count()).toBe(1);
    expect(editor.errors()).toEqual([]);
  });
});
