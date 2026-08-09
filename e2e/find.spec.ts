import { expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * Find in the page, painted through the Highlight API — no span is inserted
 * into a leaf, so a search cannot disturb the caret, the IME or the reconciler.
 *
 * Opt-in, and the demo turns it on only behind `?find=on`: in a browser `⌘F`
 * belongs to the browser, and taking it away to offer something worse is one
 * of the things this project set out not to be. The hosts with no browser find
 * of their own turn it on for real.
 */
const painted = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights;
    return { all: h.get('nbe-find')?.size ?? 0, current: h.get('nbe-find-current')?.size ?? 0 };
  });

test.describe('find in the page', () => {
  test.beforeEach(async ({ page, editor }) => {
    await editor.setDocument(['le chat dort', 'le chien aussi', 'un autre chat ici']);
    await page.goto('/?find=on');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
  });

  test('Cmd/Ctrl+F opens a bar that paints every match', async ({ page, editor }) => {
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.nbe-find-field')).toBeFocused();

    await page.keyboard.type('chat');
    await expect.poll(async () => (await painted(page)).all).toBe(2);
    expect((await painted(page)).current).toBe(1);
    await expect(page.locator('.nbe-find-status')).toHaveText('1 / 2');
    expect(editor.errors()).toEqual([]);
  });

  test('Enter steps forward, Shift+Enter back, and it wraps', async ({ page }) => {
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('chat');
    await expect(page.locator('.nbe-find-status')).toHaveText('1 / 2');

    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-find-status')).toHaveText('2 / 2');
    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-find-status')).toHaveText('1 / 2');
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.nbe-find-status')).toHaveText('2 / 2');
  });

  test('it says so when nothing matches, and Escape puts everything back', async ({ page }) => {
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('zzz');
    await expect(page.locator('.nbe-find-status')).not.toHaveText('');
    expect((await painted(page)).all).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-find-bar')).toHaveCount(0);
    expect((await painted(page)).all).toBe(0);
  });

  test('the search never puts a span in the text', async ({ page }) => {
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('chat');
    await expect.poll(async () => (await painted(page)).all).toBe(2);

    const spans = await page.evaluate(
      () => document.querySelector('.nbe-editor .nbe-leaf')!.querySelectorAll('*').length,
    );
    expect(spans).toBe(0);
  });

  test('and it is off unless a host asks for it', async ({ page, editor }) => {
    await page.goto('/');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.nbe-find-bar')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});
