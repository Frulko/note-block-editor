import { test, expect } from './fixtures';

/** Which blocks are ticked, in document order. */
const checked = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.nbe-editor .nbe-t-to_do')].map((b) => b.classList.contains('nbe-checked')),
  );

test.describe('checklists', () => {
  test('typing the Notion spelling makes a to-do', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('[] acheter du pain');

    expect(await editor.types()).toEqual(['to_do']);
    expect(await editor.texts()).toEqual(['acheter du pain']);
  });

  test('typing the Markdown spelling makes one too', async ({ editor }) => {
    // `- ` turns the block into a bullet on the way past, so the `[ ] ` that
    // follows has to be able to convert a bullet, not only a paragraph
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('- [ ] acheter du lait');

    expect(await editor.types()).toEqual(['to_do']);
    expect(await editor.texts()).toEqual(['acheter du lait']);
  });

  test('the Markdown spelling can arrive ticked', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('- [x] déjà fait');

    expect(await editor.types()).toEqual(['to_do']);
    expect(await editor.texts()).toEqual(['déjà fait']);
    expect(await checked(page)).toEqual([true]);
  });

  test('Enter continues the list, unticked', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('- [x] fait');
    await editor.press('Enter');
    await editor.type('à faire');

    expect(await editor.types()).toEqual(['to_do', 'to_do']);
    expect(await checked(page)).toEqual([true, false]);
  });

  test('Cmd/Ctrl+Enter ticks and unticks without leaving the keyboard', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('[] acheter du pain');
    await editor.press('ControlOrMeta+Enter');
    expect(await checked(page)).toEqual([true]);

    await editor.press('ControlOrMeta+Enter');
    expect(await checked(page)).toEqual([false]);
    // and it is a toggle, not an edit: the text is untouched
    expect(await editor.texts()).toEqual(['acheter du pain']);
    expect(editor.errors()).toEqual([]);
  });

  test('it ticks every to-do in a block selection', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('[] un');
    await editor.press('Enter');
    await editor.type('deux');
    await editor.press('Escape');
    await editor.press('Shift+ArrowUp');
    await editor.press('ControlOrMeta+Enter');

    expect(await checked(page)).toEqual([true, true]);
  });

  test('Tab nests a to-do under the one above it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('- [x] fait');
    await editor.press('Enter');
    await editor.type('à faire');
    await editor.press('Enter');
    await editor.press('Tab');
    await editor.type('sous-tâche');

    expect(await checked(page)).toEqual([true, false, false]);
    const nested = await page.evaluate(
      () => document.querySelectorAll('.nbe-editor .nbe-t-to_do .nbe-t-to_do').length,
    );
    expect(nested).toBe(1);
  });
});
