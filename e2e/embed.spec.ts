import { test, expect } from './fixtures';

/**
 * Nineteen entries, one block.
 *
 * The slash menu names several providers because that is how anyone finds
 * them; underneath there is one type and one table. What is worth checking in
 * a browser is the part the unit tests cannot see: that a pasted link really
 * becomes the provider's player, and that the two lines which cannot be framed
 * degrade to a link instead of a blank box.
 */

async function insert(page: import('@playwright/test').Page, editor: import('./fixtures').Editor, label: string) {
  await editor.setDocument(['']);
  await editor.caret(0, 0);
  await editor.type('/intégration');
  await page.locator('.nbe-menu-item', { hasText: label }).first().waitFor();
  await page.locator('.nbe-menu-item', { hasText: label }).first().click();
  await page.locator('.nbe-t-embed').waitFor();
}

async function paste(page: import('@playwright/test').Page, url: string) {
  await page.locator('.nbe-dropzone-url').fill(url);
  await page.locator('.nbe-dropzone-url').press('Enter');
}

test.describe('the embed block', () => {
  test('a pasted YouTube link becomes the player, not the watch page', async ({ page, editor }) => {
    await insert(page, editor, 'Intégration');
    await paste(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const frame = page.locator('.nbe-embed-frame');
    await expect(frame).toHaveAttribute('src', 'https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(editor.errors()).toEqual([]);
  });

  test('something that refuses to be framed becomes a card', async ({ page, editor }) => {
    await insert(page, editor, 'Intégration');
    await paste(page, 'https://gist.github.com/anne/abc123');

    await expect(page.locator('.nbe-embed-frame')).toHaveCount(0);
    const card = page.locator('.nbe-embed-card');
    await expect(card).toHaveAttribute('href', 'https://gist.github.com/anne/abc123');
    await expect(card.locator('.nbe-embed-card-host')).toHaveText('gist.github.com');
  });

  test('the HTML entry holds its markup in the block, sandboxed', async ({ page, editor }) => {
    await insert(page, editor, 'HTML (intégré)');
    const frame = page.locator('.nbe-embed-frame');
    // `allow-scripts` without `allow-same-origin`: together they undo the
    // sandbox, and this markup is markup somebody pasted
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const sandbox = (await frame.getAttribute('sandbox')) ?? '';
    expect(sandbox).not.toContain('allow-same-origin');
    await expect(page.frameLocator('.nbe-embed-frame').locator('p')).toHaveText('bonjour');
  });

  test('the toolbar switches an embeddable link to a card and back', async ({ page, editor }) => {
    await insert(page, editor, 'Intégration');
    await paste(page, 'https://vimeo.com/76979871');
    await expect(page.locator('.nbe-embed-frame')).toHaveCount(1);

    /*
     * The block's top edge, not its middle: the middle is the `<iframe>`, and
     * a cross-origin frame delivers no `mousemove` to the page around it. A
     * real pointer crosses the block's padding on its way in and raises the bar
     * there; a synthetic one teleports to the centre and raises nothing.
     */
    await page.locator('.nbe-t-embed').hover({ position: { x: 20, y: 1 } });
    await page.locator('.nbe-blocktoolbar-btn[aria-label="Carte"]').click();
    await expect(page.locator('.nbe-embed-card')).toHaveCount(1);

    await page.locator('.nbe-t-embed').hover();
    await page.locator('.nbe-blocktoolbar-btn[aria-label="Intégré"]').click();
    await expect(page.locator('.nbe-embed-frame')).toHaveCount(1);
    expect(editor.errors()).toEqual([]);
  });

  /*
   * A card is one line of text with a border. It carried the same edge handles
   * as a frame, offering a drag that could only make it worse — the title
   * clips, the host name comes off the edge, and the height stays one line.
   */
  test('a card has nothing to resize, and says so by having no handles', async ({ page, editor }) => {
    await insert(page, editor, 'Intégration');
    await paste(page, 'https://gist.github.com/anne/abc123');
    await expect(page.locator('.nbe-embed-card')).toHaveCount(1);
    await expect(page.locator('.nbe-t-embed .nbe-media-handle')).toHaveCount(0);
  });

  test('the bottom edge makes the frame taller, and it survives a re-render', async ({ page, editor }) => {
    await insert(page, editor, 'HTML (intégré)');
    const sizer = page.locator('.nbe-embed-sizer');
    await expect(sizer).toHaveCount(1);

    await page.locator('.nbe-t-embed').hover({ position: { x: 20, y: 1 } });
    const handle = (await page.locator('.nbe-media-handle-bottom').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 120, { steps: 8 });
    await page.mouse.up();

    const taller = await sizer.evaluate((el: HTMLElement) => el.style.height);
    expect(Number(taller.replace('px', ''))).toBeGreaterThan(480);

    // kept on the block, not on the element: typing elsewhere re-renders it
    await page.locator('.nbe-editor .nbe-leaf').last().click();
    await editor.type('après');
    await expect(sizer).toHaveAttribute('style', new RegExp(`height: ${taller.replace('px', '')}px`));
    expect(editor.errors()).toEqual([]);
  });
});
