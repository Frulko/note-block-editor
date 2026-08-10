import { test, expect, type Page } from './fixtures';

/**
 * What a *block* selection can do, which is the half of the clipboard the
 * caret does not cover.
 *
 * @remarks
 * Selecting whole blocks — Escape out of the text, ⌘A twice, a rubber band —
 * and then deleting, copying, cutting or pasting over them is table stakes in
 * every block editor there is. The pieces existed and were never asserted
 * together, which is how "paste over a block selection" ended up *appending*
 * beside the blocks it should have replaced.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Select `n` whole blocks, starting at the first: ⌘A twice, then extend. */
async function selectBlocks(page: Page, n: number): Promise<void> {
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+a`);
  for (let i = 1; i < n; i++) await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.nbe-block.nbe-selected')).toHaveCount(n);
}

/** Fire a copy at whatever holds the selection, and read what was put on it. */
function copied(page: Page): Promise<{ plain: string; nbe: string }> {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    return { plain: dt.getData('text/plain'), nbe: dt.getData('application/x-nbe') };
  });
}

test.describe('a selection of blocks', () => {
  test('Suppr deletes every block in it', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second', 'garde']);
    await selectBlocks(page, 2);
    await page.keyboard.press('Backspace');

    expect(await editor.texts()).toEqual(['garde']);
    expect(editor.errors()).toEqual([]);
  });

  test('copy takes the blocks, not the first line of them', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second', 'garde']);
    await selectBlocks(page, 2);

    const clip = await copied(page);
    expect(clip.plain).toBe('premier\n\nsecond');
    // and as blocks, so pasting them back rebuilds the types rather than prose
    expect(clip.nbe).toContain('premier');
    expect(editor.errors()).toEqual([]);
  });

  test('cut takes them away and keeps them', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second', 'garde']);
    await selectBlocks(page, 2);

    const clip = await page.evaluate(() => {
      const dt = new DataTransfer();
      (document.activeElement ?? document.body).dispatchEvent(
        new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return dt.getData('application/x-nbe');
    });
    expect(clip).toContain('second');
    expect(await editor.texts()).toEqual(['garde']);
    expect(editor.errors()).toEqual([]);
  });

  test('pasting over it replaces the blocks, instead of landing beside them', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second', 'garde']);
    await selectBlocks(page, 2);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'remplaçant');
      (document.activeElement ?? document.body).dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });

    expect(await editor.texts()).toEqual(['remplaçant', 'garde']);
    expect(editor.errors()).toEqual([]);
  });
});
