import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Block selection and drag & drop, end to end.
 *
 * @remarks
 * There was no coverage of either before 2026-08-07, which is how the whole
 * block-mode key contract came to be dead — `syncCaretFromDom` overwrote the
 * block selection from the caret the browser kept in the still-focused leaf,
 * so Escape selected a block and the next key silently dropped it — and how
 * the drop indicator came to be painted `rgba(0, 0, 0, 0)`, i.e. invisible.
 *
 * These drive the real pointer, because both faults were invisible to the
 * model: the document was fine, the *interaction* was not.
 */

/** Hover a block, then grab its ⋮⋮ handle. Returns the handle's centre. */
async function grabHandle(page: Page, index: number): Promise<{ x: number; y: number }> {
  const block = page.locator('.nbe-editor > .nbe-block').nth(index);
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  const handle = page.locator('.nbe-controls button').nth(1);
  await handle.waitFor({ state: 'visible' });
  const hb = (await handle.boundingBox())!;
  const point = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  // past the movement threshold, so the session actually starts
  await page.mouse.move(point.x + 6, point.y + 6, { steps: 2 });
  return point;
}

/** Where the drop indicator is, or null when it is not showing. */
async function guide(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.nbe-drop-guide') as HTMLElement | null;
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      side: el.classList.contains('nbe-guide-side'),
      width: Math.round(r.width),
      height: Math.round(r.height),
      background: cs.backgroundColor,
    };
  });
}

/** Move the pointer to a fraction across a block, and let the guide settle. */
async function hoverBlock(page: Page, index: number, fx: number, fy: number) {
  const box = (await page.locator('.nbe-editor > .nbe-block').nth(index).boundingBox())!;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 4 });
  await page.waitForTimeout(120); // the guide eases into place
}

test.describe('the drop indicator is visible', () => {
  test('it is a coloured line, not a transparent one', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.5, 0.8);
    const g = await guide(page);
    // the bug: tokens did not reach chrome mounted on document.body, so this
    // resolved to rgba(0, 0, 0, 0) and nothing was ever drawn
    expect(g).not.toBeNull();
    expect(g!.background).not.toContain('rgba(0, 0, 0, 0)');
    expect(g!.height).toBeLessThanOrEqual(4);
    expect(g!.width).toBeGreaterThan(100);
    await page.mouse.up();
  });

  test('it never disappears in the gap between two blocks', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    const a = (await page.locator('.nbe-editor > .nbe-block').nth(0).boundingBox())!;
    const b = (await page.locator('.nbe-editor > .nbe-block').nth(1).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, (a.y + a.height + b.y) / 2, { steps: 4 });
    await page.waitForTimeout(120);
    expect(await guide(page)).not.toBeNull();
    await page.mouse.up();
  });
});

test.describe('vertical reordering', () => {
  test('dropping above the first block moves it there', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.5, 0.2);
    await page.mouse.up();
    expect(await editor.texts()).toEqual(['troisieme', 'premier', 'deuxieme']);
    expect(editor.errors()).toEqual([]);
  });

  test('dropping below a block moves it after', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 0);
    await hoverBlock(page, 1, 0.5, 0.9);
    await page.mouse.up();
    expect(await editor.texts()).toEqual(['deuxieme', 'premier', 'troisieme']);
  });

  test('the middle of a block reorders rather than making a column', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    // 20% across used to land inside a 46%-wide column band
    await hoverBlock(page, 0, 0.2, 0.2);
    expect((await guide(page))!.side).toBe(false);
    await page.mouse.up();
    expect(await editor.texts()).toEqual(['troisieme', 'premier', 'deuxieme']);
  });

  test('Escape cancels the drag and changes nothing', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.5, 0.2);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await editor.texts()).toEqual(['premier', 'deuxieme', 'troisieme']);
  });
});

test.describe('horizontal drop makes columns', () => {
  test('the far edge shows a vertical indicator', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.99, 0.5);
    const g = await guide(page);
    expect(g!.side).toBe(true);
    expect(g!.width).toBeLessThanOrEqual(4); // a line, not a 140px slab
    await page.mouse.up();
  });

  test('dropping there builds a column layout', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.99, 0.5);
    await page.mouse.up();
    expect(await editor.types()).toContain('column_list');
    expect(editor.errors()).toEqual([]);
  });
});

test.describe('columns can be turned off', () => {
  test.use({ baseURL: 'http://localhost:5173' });

  test('the same edge drop reorders instead', async ({ page, editor }) => {
    await page.goto('/?columns=off');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await grabHandle(page, 2);
    await hoverBlock(page, 0, 0.99, 0.2);
    expect((await guide(page))!.side).toBe(false);
    await page.mouse.up();
    expect(await editor.types()).not.toContain('column_list');
    expect(await editor.texts()).toEqual(['troisieme', 'premier', 'deuxieme']);
  });
});

test.describe('the block-mode key contract', () => {
  const selected = (page: Page) => page.locator('.nbe-editor .nbe-selected').count();

  test('Escape selects the block the caret is in', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await editor.caret(1, 2);
    await editor.press('Escape');
    expect(await selected(page)).toBe(1);
  });

  test('Shift+ArrowDown extends the selection instead of dropping it', async ({ page, editor }) => {
    // the regression: the caret the browser kept in the focused leaf was
    // mapped back over the block selection before the keymap ran
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await editor.caret(0, 2);
    await editor.press('Escape');
    await editor.press('Shift+ArrowDown');
    expect(await selected(page)).toBe(2);
    await editor.press('Shift+ArrowDown');
    expect(await selected(page)).toBe(3);
  });

  test('ArrowDown moves the selection, one block at a time', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await editor.caret(0, 2);
    await editor.press('Escape');
    await editor.press('ArrowDown');
    expect(await selected(page)).toBe(1);
    expect(await page.locator('.nbe-selected .nbe-leaf').textContent()).toBe('deuxieme');
  });

  test('Backspace deletes every selected block', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await editor.caret(0, 2);
    await editor.press('Escape');
    await editor.press('Shift+ArrowDown');
    await editor.press('Backspace');
    expect(await editor.texts()).toEqual(['troisieme']);
  });

  test('Meta+Shift+ArrowDown moves the selected blocks', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme', 'troisieme']);
    await editor.caret(0, 2);
    await editor.press('Escape');
    await editor.press('Meta+Shift+ArrowDown');
    expect(await editor.texts()).toEqual(['deuxieme', 'premier', 'troisieme']);
  });

  test('Escape again leaves block mode', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme']);
    await editor.caret(0, 2);
    await editor.press('Escape');
    await editor.press('Escape');
    expect(await selected(page)).toBe(0);
  });
});
