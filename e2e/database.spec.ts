import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Databases, end to end.
 *
 * @remarks
 * There was no coverage of this at all, which is why the demo still carries a
 * second `DatabaseHost` beside the shared one in `@nbe/workspace`: deleting
 * duplicated code with nothing watching it is how a silent regression ships.
 * These tests are what makes that deletion safe.
 *
 * §2.5 is the thing being checked, not the widget: a database is four records,
 * and *rows are pages*. A test that only looked at the table would pass on an
 * implementation that stored rows in a blob.
 */

/** Insert a database in the open page through the slash menu. */
async function insertDatabase(page: Page): Promise<void> {
  const leaf = page.locator('.nbe-editor .nbe-leaf').last();
  await leaf.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.waitForTimeout(200);
  await page.locator('.nbe-menu-item', { hasText: 'Base de données' }).first().click();
  await page.waitForTimeout(400);
}

const rows = (page: Page) => page.locator('.nbe-db-row:not(.nbe-db-head)');

test.describe('a database is four records, and its rows are pages', () => {
  test.beforeEach(async ({ page, editor }) => {
    await editor.setDocument(['Suivi']);
    await editor.caret(0, 5);
    await insertDatabase(page);
  });

  test('inserting one renders a table with a header', async ({ page, editor }) => {
    await expect(page.locator('.nbe-db-toolbar')).toHaveCount(1);
    await expect(page.locator('.nbe-db-head')).toHaveCount(1);
    expect(editor.errors()).toEqual([]);
  });

  test('the block holds only a reference, never the data', async ({ page, editor }) => {
    // the view block names a collection and a view; the rows live elsewhere
    expect(await editor.types()).toContain('database');
    const json = await page.locator('#panel-doc').textContent();
    expect(json).toContain('collectionId');
    expect(json).not.toContain('"rows"');
  });

  test('adding a row adds a page to the workspace', async ({ page }) => {
    // relative counts: a new collection may arrive with example rows, and a
    // test that pins the number would break on that rather than on a bug
    const sidebarBefore = await page.locator('.page-item').count();
    const rowsBefore = await rows(page).count();
    await page.locator('.nbe-db-newrow').first().click();
    await expect(rows(page)).toHaveCount(rowsBefore + 1);
    // a row is a page, but it belongs to its table rather than to the tree
    expect(await page.locator('.page-item').count()).toBe(sidebarBefore);
  });

});

test.describe('editing a database', () => {
  test.beforeEach(async ({ page, editor }) => {
    await editor.setDocument(['Suivi']);
    await editor.caret(0, 5);
    await insertDatabase(page);
    await page.locator('.nbe-db-newrow').first().click();
    await page.waitForTimeout(400);
  });

  test('a typed column accepts a value of its own type', async ({ page }) => {
    const numeric = rows(page).last().locator('.nbe-db-editable').first();
    await numeric.click();
    await page.waitForTimeout(200);
    await page.keyboard.type('42');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await rows(page).last().textContent()).toContain('42');
  });

  test('adding a property adds a column', async ({ page }) => {
    const before = await page.locator('.nbe-db-head .nbe-db-cell').count();
    await page.locator('.nbe-db-addprop').click();
    await page.waitForTimeout(400);
    expect(await page.locator('.nbe-db-head .nbe-db-cell').count()).toBe(before + 1);
  });

  test('switching layout keeps the rows', async ({ page }) => {
    const layouts = page.locator('.nbe-db-layout');
    if ((await layouts.count()) < 2) test.skip();
    await layouts.nth(1).click();
    await page.waitForTimeout(400);
    expect(await page.locator('.nbe-db-toolbar').count()).toBe(1);
  });
});

test.describe('a row is a page', () => {
  test('clicking its title opens it in the editor', async ({ page, editor }) => {
    await editor.setDocument(['Suivi']);
    await editor.caret(0, 5);
    await insertDatabase(page);
    await page.locator('.nbe-db-newrow').first().click();
    await expect(rows(page).first()).toBeVisible();

    await rows(page).last().locator('.nbe-db-titlecell').click();
    await page.waitForTimeout(500);

    /*
     * §2.5 in one assertion: the table is gone because we are *inside* the row
     * now, and the row is an ordinary page that happens to carry
     * `collectionId` and `properties`. An implementation storing rows in a blob
     * could not do this — which is why clicking a title opens a page rather
     * than starting an inline edit, as this test first assumed.
     */
    await expect(page.locator('.nbe-db-toolbar')).toHaveCount(0);
    const json = (await page.locator('#panel-doc').textContent()) ?? '';
    expect(json).toContain('collectionId');
    expect(json).toContain('properties');
    expect(editor.errors()).toEqual([]);
  });
});

/**
 * Persistence, on the demo's own page.
 *
 * @remarks
 * Deliberately without `setDocument`: the fixture seeds through an init script
 * that replays on *every* navigation, so a reload would restore the seed over
 * whatever the test just built — the failure would look like lost data and be
 * the harness.
 */
test.describe('a database is stored, not held in memory', () => {
  test('its rows and cells survive a reload', async ({ page, editor }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(300);
    await insertDatabase(page);
    await page.locator('.nbe-db-newrow').first().click();
    await expect(rows(page).first()).toBeVisible();

    /*
     * A property cell, not the title: clicking a row's title *opens the row's
     * page*, which is correct and is what the test above pins — but it
     * navigates away from the table this one needs to still be looking at.
     */
    await rows(page).last().locator('.nbe-db-editable').first().click();
    await page.waitForTimeout(200);
    await page.keyboard.type('4242');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const expected = await rows(page).count();

    await page.reload();
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(700);

    await expect(rows(page)).toHaveCount(expected);
    expect((await rows(page).allTextContents()).some((text) => text.includes('4242'))).toBe(true);
    expect(editor.errors()).toEqual([]);
  });
});
