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

/**
 * `⌘K` is the one formatting shortcut with a dialog behind it, and it used to
 * demand a selection. The way you actually reach it is with the caret sitting
 * *in* a link you just read the URL of — nothing selected, nothing to select
 * by hand without losing your place.
 */
test.describe('Cmd/Ctrl+K and the link form', () => {
  const field = (page: import('@playwright/test').Page) => page.locator('.nbe-seltoolbar-linkform input');

  test('a selection opens the form, and Enter applies the href', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await editor.press('ControlOrMeta+k');

    await field(page).fill('https://example.com');
    await field(page).press('Enter');

    await expect(page.locator('.nbe-editor a.nbe-m-link')).toHaveAttribute('href', 'https://example.com');
    expect(editor.errors()).toEqual([]);
  });

  test('a caret inside the link is enough — it selects it for you', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await editor.press('ControlOrMeta+k');
    await field(page).fill('https://example.com');
    await field(page).press('Enter');

    await editor.caret(0, 3); // in the middle of the link, nothing selected
    await editor.press('ControlOrMeta+k');

    await expect(field(page)).toHaveValue('https://example.com');
    expect(await editor.selectionText()).toBe('bonjour');
  });

  test('with no selection and no link under the caret it does nothing', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    await editor.press('ControlOrMeta+k');

    await expect(page.locator('.nbe-seltoolbar-linkform')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});
