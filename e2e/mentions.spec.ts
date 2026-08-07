import { test, expect } from './fixtures';

/**
 * The `@` mention, end to end. Vitest proved the mark renders live; this
 * proves the trigger, the picker and the insertion behave in a real browser —
 * where the caret, the async selection and the menu overlay all participate.
 */

test.describe('inserting a mention', () => {
  test('typing @ opens the picker', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('@');
    await expect(page.locator('.nbe-mention-menu')).toBeVisible();
    expect(editor.errors()).toEqual([]);
  });

  test('the picker filters as you type', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('@');
    const before = await page.locator('.nbe-mention-menu [class*=item]').count();
    await editor.type('zzzzz');
    // nothing matches, so the menu closes rather than showing an empty list
    await expect(page.locator('.nbe-mention-menu')).toBeHidden();
    expect(before).toBeGreaterThan(0);
  });

  test('choosing inserts a mention that carries the page id', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('@');
    await page.locator('.nbe-mention-menu [class*=item]').first().click();
    const mention = page.locator('.nbe-editor .nbe-m-mention').first();
    await expect(mention).toBeVisible();
    expect(await mention.getAttribute('data-page-id')).toBeTruthy();
  });

  test('Escape closes the picker without inserting anything', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('@');
    await editor.press('Escape');
    await expect(page.locator('.nbe-mention-menu')).toBeHidden();
    expect(await page.locator('.nbe-editor .nbe-m-mention').count()).toBe(0);
  });

  test('the mention is removed by a single undo', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('@');
    await page.locator('.nbe-mention-menu [class*=item]').first().click();
    await expect(page.locator('.nbe-editor .nbe-m-mention')).toHaveCount(1);
    await editor.press('Meta+z');
    // delete + insert are one transaction, so one undo takes the whole thing
    await expect(page.locator('.nbe-editor .nbe-m-mention')).toHaveCount(0);
  });
});
