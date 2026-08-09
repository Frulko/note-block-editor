import { test, expect } from './fixtures';

/**
 * A column layout you can ask for.
 *
 * The side-drop gesture that builds columns is experimental and off by
 * default, so until now a column layout was unreachable in the shipping
 * configuration — while `EditorViewOptions.columns` documented that columns
 * "stay reachable from the slash menu either way". They are now.
 *
 * The two things worth holding on to are both about not losing anything: a
 * column must start with somewhere to type (an empty one is garbage-collected
 * in the same transaction that creates it), and asking for fewer columns must
 * move the text rather than delete it.
 */

const columns = (page: import('@playwright/test').Page) => page.locator('.nbe-t-column_list .nbe-t-column');

/** Insert a two-column layout through the slash menu, as a person would. */
async function insert(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
  await editor.setDocument(['']);
  await editor.caret(0, 0);
  await editor.type('/colonnes');
  await page.locator('.nbe-menu-item', { hasText: 'Colonnes' }).first().waitFor();
  await editor.press('Enter');
  await page.locator('.nbe-t-column_list').waitFor();
}

/** Hover a column and open one of the two toolbar menus. */
async function toolbarMenu(page: import('@playwright/test').Page, index: 0 | 1) {
  await page.locator('.nbe-t-column_list').hover();
  await page.locator('.nbe-blocktoolbar-btn').nth(index).click();
}

test.describe('the column layout', () => {
  test('the slash menu builds one, with somewhere to type in each column', async ({ page, editor }) => {
    await insert(page, editor);
    await expect(columns(page)).toHaveCount(2);
    // one empty paragraph per column: without it `normalizeWrappers` dissolves
    // the layout in the transaction that created it, because `[].every()` is true
    await expect(page.locator('.nbe-t-column > .nbe-t-paragraph')).toHaveCount(2);

    // and the caret is in the first one, so typing goes where it looks like it will
    await editor.type('à gauche');
    expect(await page.locator('.nbe-t-column').first().textContent()).toBe('à gauche');
    expect(editor.errors()).toEqual([]);
  });

  test('the toolbar changes the number of columns', async ({ page, editor }) => {
    await insert(page, editor);
    await toolbarMenu(page, 0);
    await page.locator('.nbe-menu-item', { hasText: '3 colonnes' }).click();
    await expect(columns(page)).toHaveCount(3);
  });

  test('asking for fewer keeps what was written in the ones that go', async ({ page, editor }) => {
    await insert(page, editor);
    await editor.type('gauche');
    // the second column's paragraph is the second leaf in the layout
    await page.locator('.nbe-t-column').nth(1).locator('.nbe-leaf').click();
    await editor.type('droite');

    await toolbarMenu(page, 0);
    await page.locator('.nbe-menu-item', { hasText: '3 colonnes' }).click();
    await expect(columns(page)).toHaveCount(3);
    await toolbarMenu(page, 0);
    await page.locator('.nbe-menu-item', { hasText: '2 colonnes' }).click();

    await expect(columns(page)).toHaveCount(2);
    expect(await page.locator('.nbe-t-column_list').textContent()).toContain('droite');
    expect(editor.errors()).toEqual([]);
  });

  test('the width split is a flex ratio on each column', async ({ page, editor }) => {
    await insert(page, editor);
    await toolbarMenu(page, 1);
    await page.locator('.nbe-menu-item', { hasText: 'Dernière plus large' }).click();

    const grow = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.nbe-t-column')].map((c) => c.style.flexGrow),
    );
    expect(grow).toEqual(['1', '2']);
    expect(editor.errors()).toEqual([]);
  });
});
