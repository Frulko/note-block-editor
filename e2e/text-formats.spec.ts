import { test, expect } from './fixtures';

/** The classes on the runs of the first block, in order. */
const marks = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.nbe-editor > .nbe-block:first-child .nbe-leaf span')].map((s) => [
      s.className,
      s.textContent,
    ]),
  );

test.describe('the shifted marks', () => {
  test('Cmd/Ctrl+. makes a superscript and toggles it back off', async ({ page, editor }) => {
    await editor.setDocument(['x2 + 1']);
    await editor.selectRange([0, 1], [0, 2]);
    await editor.press('ControlOrMeta+.');

    expect(await marks(page)).toEqual([['nbe-m-superscript', '2']]);
    expect(await editor.texts()).toEqual(['x2 + 1']); // a mark, not an edit

    // no re-selecting: the command leaves the range it acted on, so a second
    // press is the toggle a person would expect
    await editor.press('ControlOrMeta+.');
    expect(await marks(page)).toEqual([]);
    expect(editor.errors()).toEqual([]);
  });

  test('Cmd/Ctrl+, makes a subscript', async ({ page, editor }) => {
    await editor.setDocument(['H2O']);
    await editor.selectRange([0, 1], [0, 2]);
    await editor.press('ControlOrMeta+,');

    expect(await marks(page)).toEqual([['nbe-m-subscript', '2']]);
  });

  test('the format toolbar offers both, and applies them', async ({ page, editor }) => {
    await editor.setDocument(['x2']);
    await editor.selectRange([0, 1], [0, 2]);
    await page.locator('.nbe-seltoolbar').waitFor();

    await page.locator('.nbe-fmt-superscript').click();
    expect(await marks(page)).toEqual([['nbe-m-superscript', '2']]);
    await expect(page.locator('.nbe-fmt-subscript')).toBeVisible();
  });
});
