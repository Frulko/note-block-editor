import { test, expect } from './fixtures';

/**
 * Sizing a picture by pulling its edge.
 *
 * Presets got most of the way — 50 / 75 / 100 is what a menu is good at — and
 * what a menu cannot do is the last ten percent: the figure that has to sit
 * exactly beside a paragraph. Two handles, one per side, because the side you
 * grab decides what the drag *means*.
 */
const width = (page: import('@playwright/test').Page, selector: string) =>
  page.evaluate((s) => (document.querySelector<HTMLElement>(s)!).style.width, selector);

async function anImage(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
  await editor.setDocument(['une note']);
  // a real 1x1 gif, so the figure has a box to resize — the same fixture
  // `e2e/file-drop.spec.ts` uses. A URL that never loads gives a hidden figure.
  await page.evaluate(() => {
    const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
    const bytes = Uint8Array.from(atob('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='), (c) =>
      c.charCodeAt(0),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pixel.gif', { type: 'image/gif' }));
    const rect = leaf.getBoundingClientRect();
    const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 };
    leaf.dispatchEvent(new DragEvent('dragover', init));
    leaf.dispatchEvent(new DragEvent('drop', init));
  });
  await page.locator('.nbe-figure').waitFor();
}

/** Pull `handle` by `dx` pixels. */
async function pull(page: import('@playwright/test').Page, side: 'left' | 'right', dx: number) {
  await page.locator('.nbe-t-image').hover();
  const box = (await page.locator(`.nbe-media-handle-${side}`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('resizing an image by its edge', () => {
  test('the right handle narrows it, and the width is kept on the block', async ({ page, editor }) => {
    await anImage(page, editor);
    expect(await width(page, '.nbe-figure')).toBe('100%');

    await pull(page, 'right', -200);
    const after = Number((await width(page, '.nbe-figure')).replace('%', ''));
    expect(after).toBeLessThan(100);
    expect(after).toBeGreaterThanOrEqual(10);

    // it survives a re-render, which is what "kept on the block" means
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await editor.type('après');
    expect(await width(page, '.nbe-figure')).toBe(`${after}%`);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape abandons the drag and leaves no trace', async ({ page, editor }) => {
    await anImage(page, editor);
    await page.locator('.nbe-t-image').hover();
    const box = (await page.locator('.nbe-media-handle-right').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    expect(await width(page, '.nbe-figure')).toBe('100%');
  });

  test('it never goes below the floor', async ({ page, editor }) => {
    await anImage(page, editor);
    await pull(page, 'right', -5000);
    expect(await width(page, '.nbe-figure')).toBe('10%');
  });
});
