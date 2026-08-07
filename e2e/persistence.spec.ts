import { test, expect } from '@playwright/test';

/**
 * Pages live in IndexedDB; everything that is not a page does not.
 *
 * @remarks
 * localStorage was capped at a few megabytes, which an image-bearing workspace
 * reaches. The split is deliberate: pages are the workspace (§2.2, one document
 * each), while the open page is UI state and the collection schemas are host
 * records (§2.5) — tiny, not content, and useful before the pages have loaded.
 *
 * The migration is the part worth testing hardest: a workspace saved by the
 * previous build must not be lost to a storage change.
 */

const LEGACY = 'nbe-workspace-v1';
const META = 'nbe-workspace-meta-v1';

/** Page ids held in IndexedDB. */
async function storedPages(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nbe-demo-workspace', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<string[]>((resolve) => {
      const request = db.transaction('pages').objectStore('pages').getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
    });
  });
}

test.describe('pages persist in IndexedDB', () => {
  test('a fresh workspace seeds one page there', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(400);
    expect(await storedPages(page)).toHaveLength(1);
  });

  test('an edit survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.locator('.nbe-editor .nbe-leaf').nth(1).click();
    await page.keyboard.type(' TÉMOIN');
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(400);
    expect(await page.locator('.nbe-editor .nbe-leaf').nth(1).textContent()).toContain('TÉMOIN');
  });

  test('what is not a page is not in IndexedDB', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(400);
    const meta = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), META);
    expect(meta).not.toBeNull();
    expect(typeof meta.openId).toBe('string');
  });
});

test.describe('a workspace from the previous build is migrated, not lost', () => {
  test('its pages move to IndexedDB and the old key is dropped', async ({ page }) => {
    // seed the storage the localStorage-era build wrote, before any script runs
    await page.addInitScript(([key, id]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          openId: id,
          pages: [
            {
              id,
              type: 'page',
              version: 1,
              props: { title: 'Ancienne page' },
              children: [
                { id: `${id}-h`, type: 'heading', version: 1, props: { level: 1 }, text: [{ text: 'Ancienne page' }] },
                { id: `${id}-p`, type: 'paragraph', version: 1, text: [{ text: 'Contenu hérité' }] },
              ],
            },
          ],
        }),
      );
    }, [LEGACY, 'legacy-page-1']);

    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(500);

    expect(await storedPages(page)).toEqual(['legacy-page-1']);
    expect(await page.evaluate((key) => localStorage.getItem(key), LEGACY)).toBeNull();
    expect(await page.locator('.page-item-label').first().textContent()).toContain('Ancienne page');
    expect(await page.locator('.nbe-editor').textContent()).toContain('Contenu hérité');
  });
});
