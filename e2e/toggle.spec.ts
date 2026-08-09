import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * A toggle's Enter goes *inside* it.
 *
 * After naming a toggle, what anyone types next is the content it hides — and
 * what they got was a second toggle, because `toggle` sat in the list of types
 * Enter continues. A second toggle is never it.
 */
const nested = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('.nbe-editor .nbe-t-toggle .nbe-block').length);

test.describe('the toggle block', () => {
  test('Enter after the summary opens it and types inside', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');
    expect(await editor.types()).toEqual(['toggle']);

    await page.keyboard.press('Enter');
    await page.keyboard.type('le contenu');

    expect(await editor.types()).toEqual(['toggle']); // one top-level block
    expect(await editor.texts()).toEqual(['Mon toggle', 'le contenu']);
    expect(await nested(page)).toBe(1);
    expect(editor.errors()).toEqual([]);
  });

  test('Shift+Tab is the way back out', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('dehors');
    expect(await nested(page)).toBe(1);

    await page.keyboard.press('Shift+Tab');
    expect(await nested(page)).toBe(0);
    expect(await editor.types()).toEqual(['toggle', 'paragraph']);
    expect(await editor.texts()).toEqual(['Mon toggle', 'dehors']);
  });

  test('a collapsed toggle opens rather than swallowing what you type', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Replié');
    await page.locator('.nbe-toggle-arrow').click();
    await editor.caret(0, 6);

    await page.keyboard.press('Enter');
    await page.keyboard.type('visible');

    await expect(page.locator('.nbe-editor .nbe-t-toggle .nbe-leaf').nth(1)).toBeVisible();
    expect(await editor.texts()).toEqual(['Replié', 'visible']);
  });

  test('splitting the summary in half moves the tail inside', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> titrecontenu');
    await editor.caret(0, 5);
    await page.keyboard.press('Enter');

    expect(await editor.texts()).toEqual(['titre', 'contenu']);
    expect(await nested(page)).toBe(1);
  });

  test('an empty toggle still escapes to a paragraph', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> ');
    expect(await editor.types()).toEqual(['toggle']);
    await page.keyboard.press('Enter');
    expect(await editor.types()).toEqual(['paragraph']);
  });
});
