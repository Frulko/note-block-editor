import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * The table hover chrome: the + strips that append a row/column, and the
 * draggable column border that writes `columnWidths`.
 */

async function makeTable(page: Page, editor: { setDocument(p: string[]): Promise<void> }): Promise<void> {
  await editor.setDocument(['']);
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.nbe-t-table')).toBeVisible();
}

test.describe('table chrome', () => {
  test('the + strips append a row and a column', async ({ page, editor }) => {
    await makeTable(page, editor);
    await expect(page.locator('.nbe-t-table_row')).toHaveCount(3);

    await page.locator('.nbe-t-table').hover();
    await page.locator('.nbe-table-add-row').click();
    await expect(page.locator('.nbe-t-table_row')).toHaveCount(4);

    await page.locator('.nbe-t-table').hover();
    await page.locator('.nbe-table-add-col').click();
    await expect(page.locator('.nbe-t-table_row:first-child > .nbe-t-table_cell')).toHaveCount(4);
    expect(editor.errors()).toEqual([]);
  });

  test('dragging a column border resizes and persists columnWidths', async ({ page, editor }) => {
    await makeTable(page, editor);
    const cell = page.locator('.nbe-t-table_cell').first();
    const box = (await cell.boundingBox())!;

    // hover the right border of the first cell: the resize guide appears
    await page.mouse.move(box.x + box.width, box.y + box.height / 2);
    const resizer = page.locator('.nbe-table-col-resizer');
    await expect(resizer).toBeVisible();

    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    // the model holds the new widths, and the rendered grid uses them
    await expect(page.locator('.nbe-t-table_cell').first()).toHaveCSS('width', `${Math.round(box.width + 60)}px`);
    const widths = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.nbe-t-table')!;
      return el.style.gridTemplateColumns;
    });
    expect(widths).toMatch(/^\d+px/);
    expect(editor.errors()).toEqual([]);
  });
});
