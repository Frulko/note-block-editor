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

    await editor.press('Meta+Backspace'); // delete the block the caret is in
    expect(await entries(page)).toEqual(['Un']);
  });

  test('says so when the page has no headings at all', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);

    expect(await entries(page)).toEqual([]);
    await expect(page.locator('.nbe-toc-empty')).toBeVisible();
  });

  test('changes its look from the block menu, keeping the same entries', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await insertToc(page, editor);
    await editor.press('ArrowDown');
    await editor.type('# Un\n');
    await editor.type('## Un.un');

    const toc = page.locator('.nbe-t-table_of_contents');
    await expect(toc).toHaveAttribute('data-toc-style', 'underline');

    const box = (await toc.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.locator('.nbe-handle').click();
    await page.locator('.nbe-menu-item', { hasText: 'Numéroté' }).first().click();

    await expect(toc).toHaveAttribute('data-toc-style', 'numbered');
    expect(await entries(page)).toEqual(['Un', 'Un.un']);
    expect(editor.errors()).toEqual([]);
  });
});

/**
 * The same headings, floating beside the note.
 *
 * A feature, not a second block: it reads the same `headings(view)` and lives
 * in `slot('floating')`, so a note that contains no `[TOC]` still gets an
 * outline and `renderAll` cannot wipe it. What is worth asserting is the part
 * that is not the block's — that it appears without one, that it tracks the
 * scroll, and that a note with no headings gets no panel at all.
 */
test.describe('the floating outline', () => {
  const links = (page: import('@playwright/test').Page) =>
    page.locator('.nbe-toc-float a').allTextContents();

  test('lists the headings without a contents block in the note', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.goto('/?outline=on');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await editor.type('# Premier\n');
    await editor.type('## Sous-titre\n');
    await editor.type('# Second');

    await expect.poll(() => links(page)).toEqual(['Premier', 'Sous-titre', 'Second']);
    // and no block was inserted to get it
    expect(await editor.types()).not.toContain('table_of_contents');
    expect(editor.errors()).toEqual([]);
  });

  test('marks the section being read, and follows the scroll', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.goto('/?outline=on');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await editor.type('# Un\n');
    for (let i = 0; i < 25; i++) await editor.type(`ligne ${i}\n`);
    await editor.type('# Deux\n');
    for (let i = 0; i < 25; i++) await editor.type(`autre ${i}\n`);

    const here = () => page.locator('.nbe-toc-float a.nbe-toc-here').textContent();
    await page.evaluate(() => (document.querySelector('.page-scroll')!.scrollTop = 0));
    await expect.poll(here).toBe('Un');

    await page.evaluate(() => {
      const s = document.querySelector('.page-scroll')!;
      s.scrollTop = s.scrollHeight;
    });
    await expect.poll(here).toBe('Deux');
    expect(editor.errors()).toEqual([]);
  });

  test('a note with no headings gets no panel', async ({ page, editor }) => {
    await editor.setDocument(['juste du texte']);
    await page.goto('/?outline=on');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
    await expect(page.locator('.nbe-toc-float')).toBeHidden();
  });
});
