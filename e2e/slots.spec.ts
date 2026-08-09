import { expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * A slot is a place for chrome that is not a block: a sibling of the content
 * element, where the live region has always lived, so `renderAll` — which
 * replaces every child of the content — cannot reach it.
 *
 * The word counter is the first thing built on it, and it is here as much to
 * prove the slot survives a full re-render as to check arithmetic.
 */
test.describe('the bottom slot, and the counter in it', () => {
  test('counts words, characters and a reading time', async ({ page, editor }) => {
    await editor.setDocument(['un deux trois', 'quatre']);
    await page.goto('/?count=on');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();

    const line = page.locator('.nbe-wordcount');
    await expect(line).toBeVisible();
    await expect(line).toContainText('4 mots');
    await expect(line).toContainText('19 caractères');
    expect(editor.errors()).toEqual([]);
  });

  test('it follows what is typed', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    await page.goto('/?count=on');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await expect(page.locator('.nbe-wordcount')).toContainText('1 mots');

    await page.keyboard.press('End');
    await page.keyboard.type(' deux trois');
    await expect(page.locator('.nbe-wordcount')).toContainText('3 mots');
  });

  test('it lives outside the content, so a full re-render cannot wipe it', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un deux']);
    await page.goto('/?count=on');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();

    const inside = await page.evaluate(
      () => !!document.querySelector('.nbe-editor')!.querySelector('.nbe-wordcount'),
    );
    expect(inside).toBe(false);
    await expect(page.locator('.nbe-slot-bottom .nbe-wordcount')).toHaveCount(1);
  });

  test('and there is no slot at all when nobody asked for one', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    await page.goto('/');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
    await expect(page.locator('.nbe-slot')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});
