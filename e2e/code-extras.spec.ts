import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * A code block is a small plain-text editor, and the keys have to agree.
 *
 * Two of the three failures here came from it being treated as an ordinary
 * block: `⌘⌫` deleted the *whole block* — the editor's general binding, and
 * the one thing you never want while editing code — and Delete at the end
 * pulled the paragraph below *into* the sample, prose and all.
 */
async function makeCode(page: Page, editor: { setDocument(p: string[]): Promise<void> }) {
  await editor.setDocument(['', 'un paragraphe après']);
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
}

test.describe('the code block edits like an editor', () => {
  test('⌘⌫ deletes to the start of the line, not the block', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('const y = 2');
    await page.keyboard.press('Meta+Backspace');

    expect((await editor.texts())[0]).toBe('const x = 1\n');
    expect(await editor.types()).toEqual(['code', 'paragraph']);
    expect(editor.errors()).toEqual([]);
  });

  test('⌘⌦ deletes to the end of the line', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1');
    await editor.caret(0, 5);
    await page.keyboard.press('Meta+Delete');
    expect((await editor.texts())[0]).toBe('const');
  });

  test('Backspace at the start does not turn the code into prose', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1');
    await editor.caret(0, 0);
    await page.keyboard.press('Backspace');
    expect(await editor.types()).toEqual(['code', 'paragraph']);
    expect((await editor.texts())[0]).toBe('const x = 1');
  });

  test('Delete at the end does not pull the next block into the sample', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1');
    await page.keyboard.press('Delete');
    expect(await editor.types()).toEqual(['code', 'paragraph']);
    expect((await editor.texts())[0]).toBe('const x = 1');
    expect((await editor.texts())[1]).toBe('un paragraphe après');
    expect(editor.errors()).toEqual([]);
  });

  test('a blank line typed with two Enters can be taken back out', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('deux');
    expect((await editor.texts())[0]).toBe('un\n\ndeux');

    await editor.caret(0, 4);
    await page.keyboard.press('Backspace');
    expect((await editor.texts())[0]).toBe('un\ndeux');
  });
});

test.describe('line numbers and a caption', () => {
  test('the numbers are beside the code, not in it', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Enter');
    await page.keyboard.type('deux');

    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn[aria-label="Numéros de ligne"]').click();
    await expect(page.locator('.nbe-code-gutter span')).toHaveCount(2);

    // the invariant the whole block rests on: the leaf holds text and nothing else
    const spans = await page.evaluate(() => document.querySelector('.nbe-t-code .nbe-leaf')!.querySelectorAll('*').length);
    expect(spans).toBe(0);
    expect((await editor.texts())[0]).toBe('un\ndeux');
    expect(editor.errors()).toEqual([]);
  });

  test('copying the block does not copy the numbers', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn[aria-label="Numéros de ligne"]').click();
    await expect(page.locator('.nbe-code-gutter span')).toHaveCount(1);

    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.press('ControlOrMeta+a');
    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.activeElement?.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    });
    expect(copied).toContain('un');
    expect(copied).not.toContain('1');
  });

  test('a caption is stored on the block and shown under it', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn[aria-label="Ajouter une légende"]').click();
    await page.locator('.nbe-blocktoolbar-menu input').fill('Le tri fusion');
    await page.locator('.nbe-blocktoolbar-menu input').press('Enter');

    await expect(page.locator('.nbe-code-caption')).toHaveText('Le tri fusion');
    // and it is not part of the code
    expect((await editor.texts())[0]).toBe('un');
  });
});
