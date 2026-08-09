import { test, expect } from './fixtures';

/**
 * A menu opened by typing a character points at that character.
 *
 * It used to point at the *block*, whose rect starts at the left margin — so
 * typing `/` at the end of a sentence opened the palette back at the beginning
 * of the line, nowhere near where the eye was.
 */
test.describe('the slash palette follows the caret', () => {
  test('opens under the `/`, not at the left margin', async ({ page, editor }) => {
    await editor.setDocument(['une phrase assez longue pour que la fin soit loin de la marge']);
    await editor.caret(0, 61);
    await editor.type('/');
    await page.locator('.nbe-slash-menu').waitFor();

    const { menu, leaf, caret } = await page.evaluate(() => {
      const range = document.getSelection()!.getRangeAt(0).cloneRange();
      range.collapse(false);
      return {
        menu: document.querySelector('.nbe-slash-menu')!.getBoundingClientRect().x,
        leaf: document.querySelector('.nbe-editor .nbe-leaf')!.getBoundingClientRect().x,
        caret: range.getBoundingClientRect().x,
      };
    });

    // near the caret, and demonstrably not back at the block's left edge
    expect(Math.abs(menu - caret)).toBeLessThan(30);
    expect(menu - leaf).toBeGreaterThan(100);
    expect(editor.errors()).toEqual([]);
  });

  test('still opens sensibly on an empty block, where there is no character yet', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('/');
    await page.locator('.nbe-slash-menu').waitFor();

    const { menu, leaf } = await page.evaluate(() => ({
      menu: document.querySelector('.nbe-slash-menu')!.getBoundingClientRect().x,
      leaf: document.querySelector('.nbe-editor .nbe-leaf')!.getBoundingClientRect().x,
    }));
    expect(Math.abs(menu - leaf)).toBeLessThan(30);
  });
});
