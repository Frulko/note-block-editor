import { expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * Commenting used to go through `prompt()` — a modal the operating system
 * draws, which steals focus, cannot show what is being commented on, and is a
 * full-screen sheet on a phone. It is the editor's own floating panel now, the
 * same one the code block's language picker uses.
 */
test.describe('adding a comment', () => {
  test('opens a bubble with a textarea, and Enter sends it', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    // no dialog may appear; if one did, this listener is what proves it
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();

    const field = page.locator('.comment-compose .compose-field');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();

    await page.keyboard.type('mon commentaire');
    await page.keyboard.press('Enter');

    await expect(page.locator('#panel-comments .message-body')).toHaveText('mon commentaire');
    expect(dialogs).toEqual([]);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape gives up without leaving a thread behind', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();
    await expect(page.locator('.comment-compose .compose-field')).toBeVisible();

    await page.keyboard.type('presque');
    await page.keyboard.press('Escape');

    await expect(page.locator('.comment-compose')).toHaveCount(0);
    await expect(page.locator('#panel-comments .message-body')).toHaveCount(0);
  });
});
