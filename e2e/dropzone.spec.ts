import { test, expect } from './fixtures';

/**
 * A block you drop files onto, which keeps them as a list.
 *
 * A `file` block is one file; this is the other shape the same need takes — a
 * place on the page where things accumulate. Two things are worth holding on
 * to: a batch is one transaction (`props.files` is replaced wholesale, so a
 * dispatch per file would have each one overwrite the list the previous had
 * just written, and dropping five would keep one), and a zone with a kind
 * refuses what it is not for.
 */

/** Drop `files` on the zone, as the browser delivers them. */
async function dropOn(
  page: import('@playwright/test').Page,
  files: Array<{ name: string; type: string }>,
) {
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File(['x'.repeat(20)], f.name, { type: f.type }));
    document
      .querySelector('.nbe-dropzone-target')!
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

async function insert(
  page: import('@playwright/test').Page,
  editor: import('./fixtures').Editor,
  query: string,
) {
  await editor.setDocument(['']);
  await editor.caret(0, 0);
  await editor.type(`/${query}`);
  await page.locator('.nbe-menu-item', { hasText: 'Zone de dépôt' }).first().waitFor();
  await editor.press('Enter');
  await page.locator('.nbe-t-drop_zone').waitFor();
}

test.describe('the drop zone', () => {
  test('keeps every file of a batch, not just the last one', async ({ page, editor }) => {
    await insert(page, editor, 'dépôt');
    await dropOn(page, [
      { name: 'un.txt', type: 'text/plain' },
      { name: 'deux.txt', type: 'text/plain' },
      { name: 'trois.txt', type: 'text/plain' },
    ]);

    await expect(page.locator('.nbe-dropzone-file')).toHaveCount(3);
    expect(await page.locator('.nbe-dropzone-file span').first().textContent()).toBe('un.txt');
    expect(editor.errors()).toEqual([]);
  });

  test('a PDF zone refuses what it is not for', async ({ page, editor }) => {
    // the slash menu offers one entry per kind, so the choice is made up front
    await insert(page, editor, 'dépôt — pdf');
    await dropOn(page, [
      { name: 'rapport.pdf', type: 'application/pdf' },
      { name: 'photo.png', type: 'image/png' },
    ]);

    await expect(page.locator('.nbe-dropzone-file')).toHaveCount(1);
    expect(await page.locator('.nbe-dropzone-file span').first().textContent()).toBe('rapport.pdf');
  });

  test('a file can be taken back out', async ({ page, editor }) => {
    await insert(page, editor, 'dépôt');
    await dropOn(page, [
      { name: 'un.txt', type: 'text/plain' },
      { name: 'deux.txt', type: 'text/plain' },
    ]);
    await expect(page.locator('.nbe-dropzone-file')).toHaveCount(2);

    await page.locator('.nbe-dropzone-remove').first().click();
    await expect(page.locator('.nbe-dropzone-file')).toHaveCount(1);
    expect(await page.locator('.nbe-dropzone-file span').first().textContent()).toBe('deux.txt');
    expect(editor.errors()).toEqual([]);
  });

  test('the drop is the zone’s, not also the editor’s', async ({ page, editor }) => {
    await insert(page, editor, 'dépôt');
    await dropOn(page, [{ name: 'un.txt', type: 'text/plain' }]);
    await expect(page.locator('.nbe-dropzone-file')).toHaveCount(1);
    // the editor's own handler would have made a second, separate file block
    await expect(page.locator('.nbe-t-file')).toHaveCount(0);
  });
});
