import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * The syntax palette is chosen the same way the editor's own theme is — an
 * attribute on a host element — because that hook already exists and already
 * reaches everything. No option threaded through three packages.
 *
 * Each theme is a *pair*: a dark palette on a light page is unreadable, so the
 * page's own light/dark decides which of the two applies.
 */
const keyword = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.querySelector('.nbe-editor')!).getPropertyValue('--nbe-code-keyword').trim(),
  );

test.describe('the code block’s syntax theme', () => {
  test('a host attribute changes the palette, and the page’s theme picks the mode', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.type('```');
    await expect(page.locator('.nbe-t-code')).toBeVisible();

    const fallback = await keyword(page);
    expect(fallback).toBeTruthy();

    await page.evaluate(() => (document.body.dataset.nbeCodeTheme = 'solarized'));
    const solarized = await keyword(page);
    expect(solarized).not.toBe(fallback);

    await page.evaluate(() => (document.body.dataset.nbeCodeTheme = 'github'));
    const githubLight = await keyword(page);
    expect(githubLight).not.toBe(solarized);

    await page.evaluate(() => (document.documentElement.dataset.nbeTheme = 'dark'));
    expect(await keyword(page)).not.toBe(githubLight);

    // and removing it goes back to the default, which needs no attribute
    await page.evaluate(() => {
      delete document.body.dataset.nbeCodeTheme;
      delete document.documentElement.dataset.nbeTheme;
    });
    expect(await keyword(page)).toBe(fallback);
    expect(editor.errors()).toEqual([]);
  });
});
