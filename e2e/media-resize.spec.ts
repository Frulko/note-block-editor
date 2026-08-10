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

/**
 * Where a picture sits when nobody has said.
 *
 * @remarks
 * Centred. Text runs the width of the column and a figure usually does not, so
 * left-aligning one puts a ragged edge down the middle of the page — left is
 * the right default for *text*, and an image is not text.
 *
 * The default lived as `?? 'left'` in four places across two packages, which is
 * four things that had to agree and no reason they would: a renderer reading
 * one value and a toolbar reading another is a toolbar showing the wrong button
 * as active. `DEFAULT_ALIGN` is the one place now, and this checks the two ends
 * of it — what is drawn, and what the menu says is current.
 */
test.describe('a media block with no alignment of its own', () => {
  test('is centred, in the document and in its toolbar', async ({ page, editor }) => {
    await anImage(page, editor);

    const block = page.locator('.nbe-t-image');
    await expect(block).toHaveClass(/nbe-align-center/);
    // and it really is centred, rather than merely labelled so
    const gap = await page.evaluate(() => {
      const fig = document.querySelector('.nbe-figure')!.getBoundingClientRect();
      const box = document.querySelector('.nbe-t-image')!.getBoundingClientRect();
      return { left: fig.left - box.left, right: box.right - fig.right };
    });
    expect(Math.abs(gap.left - gap.right)).toBeLessThan(2);

    // the toolbar has to agree, or the menu offers "centre" as if it were off
    await block.hover({ position: { x: 20, y: 1 } });
    await page.locator('.nbe-blocktoolbar-btn[aria-label^="Aligner"]').click();
    const current = page.locator('.nbe-blocktoolbar-menu .nbe-menu-item', { hasText: 'Centrer' });
    await expect(current.locator('.nbe-icon')).toHaveCount(1);
    expect(editor.errors()).toEqual([]);
  });
});
