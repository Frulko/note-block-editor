import { test, expect } from './fixtures';

/**
 * The one block whose content is the *document*. Everything interesting about
 * it is that it must change when something else does.
 */
const entries = (page: import('@playwright/test').Page) =>
  page.locator('.nbe-t-table_of_contents .nbe-toc-list a').allTextContents();

/** Insert a table of contents through the slash menu, as a person would. */
async function insertToc(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
  await editor.type('/sommaire');
  await page.locator('.nbe-menu-item', { hasText: 'Sommaire' }).first().waitFor();
  await editor.press('Enter');
  await page.locator('.nbe-t-table_of_contents').waitFor();
}

test.describe('the table of contents', () => {
  test('lists the headings of the page, in order, and follows one on click', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);
    await editor.press('ArrowDown');

    await editor.type('# Premier\n');
    await editor.type('## Sous-titre\n');
    await editor.type('du texte\n');
    await editor.type('# Second');

    expect(await entries(page)).toEqual(['Premier', 'Sous-titre', 'Second']);

    await page.locator('.nbe-toc-list a', { hasText: 'Second' }).click();
    const focused = await page.evaluate(() => {
      const node = document.getSelection()?.focusNode;
      const el = (node?.nodeType === 1 ? node : node?.parentElement) as Element | null;
      return el?.closest('.nbe-block')?.textContent ?? null;
    });
    expect(focused).toBe('Second');
    expect(editor.errors()).toEqual([]);
  });

  test('follows a heading being renamed', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);
    await editor.press('ArrowDown');
    await editor.type('# Titre');
    expect(await entries(page)).toEqual(['Titre']);

    await editor.type(' modifié');
    expect(await entries(page)).toEqual(['Titre modifié']);
  });

  test('drops a heading that is deleted', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);
    await editor.press('ArrowDown');
    await editor.type('# Un\n');
    await editor.type('# Deux');
    expect(await entries(page)).toEqual(['Un', 'Deux']);

    await editor.press('ControlOrMeta+Backspace'); // delete the block the caret is in
    expect(await entries(page)).toEqual(['Un']);
  });

  test('says so when the page has no headings at all', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);

    expect(await entries(page)).toEqual([]);
    await expect(page.locator('.nbe-toc-empty')).toBeVisible();
  });
});
