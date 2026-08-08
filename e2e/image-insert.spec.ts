import { test, expect } from '@playwright/test';

/**
 * An image arrives by paste or by drop, and becomes an image block.
 *
 * @remarks
 * Both paths go through the same asset pipeline (AQ#2): the host's
 * `onStoreAsset` writes the bytes and hands back an opaque `asset:<hash>`,
 * `resolveAssetUrl` turns it back into something an `<img>` can load. The two
 * entry points are separate listeners though, and a regression in one is
 * invisible from the other — so both are exercised here.
 */

/** A 1×1 PNG, small enough to inline. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function focusEmptyEnd(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForSelector('.nbe-editor .nbe-leaf');
  const last = page.locator('.nbe-editor .nbe-leaf').last();
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

test.describe("une image s'insère par presse-papiers ou par glisser-déposer", () => {
  test('collée depuis le presse-papiers', async ({ page }) => {
    await focusEmptyEnd(page);
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pixel.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG);

    const img = page.locator('.nbe-editor img.nbe-image');
    await expect(img).toHaveCount(1);
    // resolved to a loadable url, not left as the opaque asset: ref
    await expect(img).toHaveJSProperty('naturalWidth', 1);
  });

  test('déposée depuis le bureau', async ({ page }) => {
    await focusEmptyEnd(page);
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pixel.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const leaf = document.querySelectorAll('.nbe-editor .nbe-leaf');
      const target = leaf[leaf.length - 1]!;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 4,
          clientY: rect.top + 4,
        }),
      );
    }, PNG);

    const img = page.locator('.nbe-editor img.nbe-image');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveJSProperty('naturalWidth', 1);
  });
});
