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

  test('a commented block carries a marker, with a count once there are two', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un bloc à commenter', 'un autre']);
    const marker = page.locator('.nbe-editor > .nbe-block').first().locator('.nbe-comment-marker');
    await expect(marker).toHaveCount(0);

    const addComment = async (body: string) => {
      await page.locator('.nbe-editor > .nbe-block').first().hover();
      await page.locator('.nbe-controls-right .nbe-comment').click();
      await page.locator('.comment-compose .compose-field').waitFor();
      await page.keyboard.type(body);
      await page.keyboard.press('Enter');
    };

    await addComment('le premier');
    // visible without hovering: move the pointer well away first
    await page.mouse.move(2, 2);
    await expect(marker).toHaveCount(1);
    await expect(marker.locator('.nbe-comment-count')).toHaveText('');
    // and only on the block that was commented
    await expect(page.locator('.nbe-editor > .nbe-block').nth(1).locator('.nbe-comment-marker')).toHaveCount(0);

    await addComment('le second');
    await page.mouse.move(2, 2);
    await expect(marker.locator('.nbe-comment-count')).toHaveText('2');
    expect(editor.errors()).toEqual([]);
  });

  test('the marker survives typing in another block', async ({ page, editor }) => {
    await editor.setDocument(['commenté', 'autre']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();
    await page.locator('.comment-compose .compose-field').waitFor();
    await page.keyboard.type('coucou');
    await page.keyboard.press('Enter');

    await editor.caret(1, 5);
    await editor.type(' encore');
    await page.mouse.move(2, 2);
    await expect(page.locator('.nbe-editor .nbe-comment-marker')).toHaveCount(1);
  });
});
