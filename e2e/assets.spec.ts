import { test, expect } from '@playwright/test';

/**
 * Orphaned binaries are collected (AQ#2).
 *
 * @remarks
 * Mark-and-sweep, never reference counting, and it runs **once at load** —
 * which is the whole safety argument. An undone deletion restores its blocks,
 * so a blob is only garbage while nothing can bring a reference back, and the
 * undo history lives in memory and dies with the page.
 */

/** Blob hashes currently in the asset store. */
async function storedAssets(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nbe-assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('blobs')) return [];
    return new Promise<string[]>((resolve) => {
      const request = db.transaction('blobs').objectStore('blobs').getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String));
    });
  });
}

/** Put a blob in the store that no page refers to. */
async function plantOrphan(page: import('@playwright/test').Page, key: string) {
  await page.evaluate(async (hash) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nbe-assets', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('blobs')) request.result.createObjectStore('blobs');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve) => {
      const request = db.transaction('blobs', 'readwrite').objectStore('blobs').put(new Blob(['x']), hash);
      request.onsuccess = () => resolve();
    });
  }, key);
}

test.describe('unused binaries do not accumulate', () => {
  test('an orphaned blob is gone after the next load', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(400);

    await plantOrphan(page, 'orphelin1234');
    expect(await storedAssets(page)).toContain('orphelin1234');

    await page.reload();
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(700);
    expect(await storedAssets(page)).not.toContain('orphelin1234');
  });

  test('a blob a page still refers to is kept', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(400);
    await plantOrphan(page, 'utilise5678');

    // reference it from the open page, the way an inserted image would
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('nbe-demo-workspace', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = db.transaction('pages', 'readwrite').objectStore('pages');
      const pages: Array<{ id: string; children?: unknown[] }> = await new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
      });
      const first = pages[0]!;
      (first.children ??= []).push({
        id: 'img-1',
        type: 'image',
        version: 1,
        props: { src: 'asset:utilise5678' },
      });
      await new Promise<void>((resolve) => {
        const put = db.transaction('pages', 'readwrite').objectStore('pages').put(first, first.id);
        put.onsuccess = () => resolve();
      });
    });

    await page.reload();
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(700);
    expect(await storedAssets(page)).toContain('utilise5678');
  });
});
