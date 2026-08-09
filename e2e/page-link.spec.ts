import { test, expect } from './fixtures';

/**
 * A block that points at a page you already have.
 *
 * The sibling of « Page », and a different intent: that one creates, this one
 * links — so it is gated on `onSearchPages` rather than on `onCreatePage`, and
 * it is absent rather than dead in a host with nowhere to look. What is worth
 * asserting is that the picker is reachable *both* ways (on insert and from
 * the block's own menu, which is the "context menu" half of it) and that it is
 * drivable from the keyboard, since it is built on the shared combobox.
 */

async function insertLink(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
  await editor.setDocument(['une note']);
  await editor.caret(0, 8);
  await editor.press('Enter');
  await editor.type('/lien');
  await page.locator('.nbe-menu-item', { hasText: 'Lien vers une page' }).first().waitFor();
  await editor.press('Enter');
}

test.describe('the page link', () => {
  test('inserting one opens the picker straight away', async ({ page, editor }) => {
    await insertLink(page, editor);
    // an empty page link is not a state to leave anyone in
    await expect(page.locator('.nbe-pagemenu')).toBeVisible();
    await expect(page.locator('.nbe-pagemenu input')).toBeFocused();
    expect(editor.errors()).toEqual([]);
  });

  test('choosing a page from the vault names the block', async ({ page, editor }) => {
    await insertLink(page, editor);
    const first = page.locator('.nbe-pagemenu .nbe-menu-item').first();
    const chosen = (await first.textContent())?.trim();
    await first.click();

    const link = page.locator('.nbe-t-link_to_page .nbe-page-link-title');
    await expect(link).toBeVisible();
    expect((await link.textContent())?.trim()).toBe(chosen);
    expect(editor.errors()).toEqual([]);
  });

  test('the search field hands the arrows and Enter to the list', async ({ page, editor }) => {
    await insertLink(page, editor);
    // the first entry is already the highlighted one, so one ArrowDown is the
    // second — which is what proves the keys reached the list and not the field
    const second = (await page.locator('.nbe-pagemenu .nbe-menu-item').nth(1).textContent())?.trim();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.locator('.nbe-pagemenu')).toHaveCount(0);
    // the field kept the typing and the list took the keys — the whole point
    // of the shared combobox
    expect((await page.locator('.nbe-page-link-title').textContent())?.trim()).toBe(second);
  });

  test('the block’s own menu can point it somewhere else', async ({ page, editor }) => {
    await insertLink(page, editor);
    await page.locator('.nbe-pagemenu .nbe-menu-item').first().click();

    await page.locator('.nbe-t-link_to_page').hover();
    await page.locator('.nbe-handle').click();
    await page.locator('.nbe-menu-item', { hasText: 'Rechercher une page' }).click();
    await expect(page.locator('.nbe-pagemenu')).toBeVisible();
    expect(editor.errors()).toEqual([]);
  });
});
