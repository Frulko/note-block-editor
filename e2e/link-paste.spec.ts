import { test, expect } from './fixtures';

/**
 * What a pasted link was meant to be.
 *
 * The same `https://…` is a citation in a sentence, a video to watch here, a
 * bookmark to come back to, or a page in this vault — and the editor cannot
 * tell them apart. Guessing picks wrong three times in four and every wrong
 * guess is an edit to undo, so the paste does the safe thing and *then* offers
 * the rest. The offer must never be in the way: typing on leaves the link
 * exactly as the paste made it.
 */
const paste = (page: import('@playwright/test').Page, text: string) =>
  page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);

test.describe('a pasted link', () => {
  test('lands as a link, and offers what else it could be', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');

    // the safe thing has already happened
    await expect(page.locator('.nbe-m-link')).toHaveText('https://vimeo.com/76979871');
    const menu = page.locator('.nbe-linkpaste-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.nbe-menu-item')).toHaveCount(3); // embed, bookmark, plain
    expect(editor.errors()).toEqual([]);
  });

  test('Escape leaves the link exactly as the paste made it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.keyboard.press('Escape');

    await expect(page.locator('.nbe-linkpaste-menu')).toHaveCount(0);
    expect(await editor.types()).toEqual(['paragraph']);
    expect((await editor.texts())[0]).toBe('https://vimeo.com/76979871');
  });

  test('choosing the embed replaces the paragraph it was alone in', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Intégration' }).click();

    await expect(page.locator('.nbe-embed-frame')).toHaveAttribute(
      'src',
      'https://player.vimeo.com/video/76979871',
    );
    // the empty paragraph it came out of went with it
    expect(await editor.types()).toEqual(['embed']);
  });

  test('a bookmark keeps the paragraph it was pasted into', async ({ page, editor }) => {
    await editor.setDocument(['une phrase avec ']);
    await editor.caret(0, 16);
    await paste(page, 'https://gist.github.com/anne/abc');
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Signet' }).click();

    expect(await editor.types()).toEqual(['paragraph', 'embed']);
    expect((await editor.texts())[0]).toBe('une phrase avec ');
    await expect(page.locator('.nbe-embed-card')).toHaveCount(1);
  });

  test('the keyboard drives it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-embed-frame')).toHaveCount(1);
  });
});

test.describe('a link already in the document', () => {
  test('a paragraph that is nothing but a link offers the same conversion', async ({ page, editor }) => {
    await editor.setDocument(['https://vimeo.com/76979871', 'de la prose']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    await page.locator('.nbe-menu-item', { hasText: 'Transformer en intégration' }).click();
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Intégration' }).click();

    expect(await editor.types()).toEqual(['embed', 'paragraph']);
  });

  test('and an ordinary paragraph does not', async ({ page, editor }) => {
    await editor.setDocument(['de la prose ordinaire']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    await expect(page.locator('.nbe-menu-item', { hasText: 'Transformer en intégration' })).toHaveCount(0);
  });
});
