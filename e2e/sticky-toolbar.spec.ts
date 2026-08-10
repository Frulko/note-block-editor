import { test, expect } from './fixtures';

/**
 * The format bar in its older shape: pinned above the note.
 *
 * @remarks
 * Same bar, same seven marks, same sub-menus — three things differ, and only
 * three are worth a browser to check. It is there before anything is selected,
 * it stays there after the selection is gone, and with a caret that has
 * selected nothing the mark buttons are *disabled* rather than silently doing
 * nothing.
 *
 * That last one is the decision. A pinned bar is looked at all the time, so
 * "nothing is selected" needs an answer; applying to what you type next is a
 * pending-format state the model does not have, and applying to the word under
 * the caret is a guess. Saying so is the honest third option.
 */
const url = '/?toolbar=sticky';

test.describe('the pinned format toolbar', () => {
  test('is there before anything is selected', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    const bar = page.locator('.nbe-seltoolbar-sticky');
    await expect(bar).toHaveCount(1);
    // above the content, not floating over it
    const inSlot = await bar.evaluate((el) => !!el.closest('.nbe-slot-top'));
    expect(inSlot).toBe(true);
  });

  test('its mark buttons are disabled with nothing selected, and live with', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    const bold = page.locator('.nbe-seltoolbar-sticky .nbe-fmt-bold');
    await expect(bold).toBeDisabled();

    await editor.selectRange([0, 0], [0, 7]);
    await expect(bold).toBeEnabled();
  });

  test('it applies a mark to the selection, like the floating one', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.locator('.nbe-seltoolbar-sticky .nbe-fmt-bold').click();

    await expect(page.locator('.nbe-editor .nbe-m-bold')).toHaveText('bonjour');
    expect(await editor.texts()).toEqual(['bonjour monde']); // a mark, not an edit
    expect(editor.errors()).toEqual([]);
  });

  test('« Transformer en » stays live on a caret — a block needs no selection', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    await page.locator('.nbe-seltoolbar-sticky .nbe-seltoolbar-turn').click();
    await page.locator('.nbe-seltoolbar-menu .nbe-menu-item', { hasText: 'Titre 1' }).first().click();
    await expect(page.locator('.nbe-editor .nbe-t-heading')).toHaveCount(1);
    expect(editor.errors()).toEqual([]);
  });

  test('and the floating one is not also there', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.waitForTimeout(200);
    // one bar, and it is the pinned one: two offering the same seven marks,
    // one hovering over the other, is not a configuration anyone chose
    await expect(page.locator('.nbe-seltoolbar')).toHaveCount(1);
    await expect(page.locator('.nbe-seltoolbar-sticky')).toHaveCount(1);
  });

  test('the default is still the floating bar', async ({ page, editor }) => {
    await page.goto('/');
    await editor.setDocument(['bonjour monde']);
    await expect(page.locator('.nbe-seltoolbar-sticky')).toHaveCount(0);
    await editor.selectRange([0, 0], [0, 7]);
    await expect(page.locator('.nbe-seltoolbar')).toHaveCount(1);
  });
});
