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

  test('the + strip survives the pointer travelling to it', async ({ page, editor }) => {
    // it sits outside the table, so the pointer crosses bare page on the way:
    // hiding on that first event made the button vanish under the cursor
    await makeTable(page, editor);
    const box = (await page.locator('.nbe-t-table').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 20);
    await page.mouse.move(box.x + 40, box.y + box.height + 2);
    await expect(page.locator('.nbe-table-add-row')).toBeVisible();
    await page.locator('.nbe-table-add-row').click();
    await expect(page.locator('.nbe-t-table_row')).toHaveCount(4);
    expect(editor.errors()).toEqual([]);
  });

  test('a table wider than the page scrolls instead of squashing its columns', async ({ page, editor }) => {
    await makeTable(page, editor);
    for (let i = 0; i < 6; i++) {
      // a point well inside the first cell: the table's centre may be a column
      // border, where the resize guide takes the pointer
      const box = (await page.locator('.nbe-t-table').boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 20);
      await page.locator('.nbe-table-add-col').click();
    }
    const metrics = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.nbe-t-table')!;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, cells: el.children[0]!.children.length };
    });
    expect(metrics.cells).toBe(9);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
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

test.describe('cell selection', () => {
  /** Drag from the middle of one cell to the middle of another. */
  async function dragCells(page: Page, from: number, to: number): Promise<void> {
    const cells = page.locator('.nbe-t-table_cell');
    const a = (await cells.nth(from).boundingBox())!;
    const b = (await cells.nth(to).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
  }

  test('a drag across cells selects the rectangle they span', async ({ page, editor }) => {
    await makeTable(page, editor);
    await dragCells(page, 0, 4); // (0,0) → (1,1): a 2×2 block
    await expect(page.locator('.nbe-cell-sel')).toHaveCount(4);
    // and the browser is not left holding a text selection across the cells
    expect(await editor.selectionText()).toBe('');
    expect(editor.errors()).toEqual([]);
  });

  test('merges the selection into one cell, and splits it back', async ({ page, editor }) => {
    await makeTable(page, editor);
    // the slash command leaves the caret in the first cell
    await page.keyboard.type('a');
    await expect(page.locator('.nbe-t-table_cell').first()).toContainText('a');
    await dragCells(page, 0, 4);

    await page.locator('.nbe-cellbar button').first().click();
    const merged = page.locator('.nbe-cell-merged');
    await expect(merged).toHaveCount(1);
    await expect(merged).toHaveCSS('grid-column-start', 'span 2');
    // 9 cells minus the 3 swallowed, and the typed text survived the merge
    await expect(page.locator('.nbe-t-table_cell')).toHaveCount(6);
    await expect(merged).toContainText('a');

    // clicking a merged cell offers the split, which gives the slots back
    await merged.click();
    await page.locator('.nbe-cellbar button').first().click();
    await expect(page.locator('.nbe-cell-merged')).toHaveCount(0);
    await expect(page.locator('.nbe-t-table_cell')).toHaveCount(9);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape drops the selection', async ({ page, editor }) => {
    await makeTable(page, editor);
    await dragCells(page, 0, 4);
    await expect(page.locator('.nbe-cell-sel')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-cell-sel')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});
