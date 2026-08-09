import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * Dropping a file that is not an image.
 *
 * Two failures in one gesture, and the second is the serious one: nothing was
 * inserted, *and* the drop was left un-cancelled, so the browser did what it
 * does with a dropped file — navigated the tab to it, taking the page being
 * written off screen.
 */
async function drop(page: Page, name: string, type: string, body = 'bonjour'): Promise<void> {
  await page.evaluate(
    ({ name, type, body }) => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      const dt = new DataTransfer();
      dt.items.add(new File([body], name, { type }));
      const rect = leaf.getBoundingClientRect();
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 };
      leaf.dispatchEvent(new DragEvent('dragover', init));
      leaf.dispatchEvent(new DragEvent('drop', init));
    },
    { name, type, body },
  );
}

test.describe('dropping a file', () => {
  test('a text file becomes a file block with its name and size', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    await drop(page, 'notes.txt', 'text/plain');

    await expect(page.locator('.nbe-editor .nbe-t-file')).toHaveCount(1);
    await expect(page.locator('.nbe-file-link')).toContainText('notes.txt');
    await expect(page.locator('.nbe-file-size')).toContainText('o');
    expect(editor.errors()).toEqual([]);
  });

  test('the page stays put — the drop is cancelled before anything else', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    const before = page.url();
    await drop(page, 'archive.zip', 'application/zip');
    await page.waitForTimeout(200);

    expect(page.url()).toBe(before);
    await expect(page.locator('.nbe-editor')).toBeVisible();
  });

  test('an image still becomes an image, not a file', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    // a 1x1 gif, the same fixture e2e/image-insert.spec.ts uses
    await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      const bytes = Uint8Array.from(atob('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'pixel.gif', { type: 'image/gif' }));
      const rect = leaf.getBoundingClientRect();
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 };
      leaf.dispatchEvent(new DragEvent('dragover', init));
      leaf.dispatchEvent(new DragEvent('drop', init));
    });

    await expect(page.locator('.nbe-editor .nbe-t-image')).toHaveCount(1);
    await expect(page.locator('.nbe-editor .nbe-t-file')).toHaveCount(0);
  });

  test('a PDF gets the browser’s own viewer, with the link as fallback', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    await drop(page, 'guide.pdf', 'application/pdf', '%PDF-1.4');

    const preview = page.locator('.nbe-editor object.nbe-file-preview');
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveAttribute('type', 'application/pdf');
    await expect.poll(async () => (await preview.getAttribute('data')) ?? '').toMatch(/^blob:/);
    // the download link is there either way, which is what makes a missing
    // viewer a non-event
    await expect(page.locator('.nbe-file-link').first()).toContainText('guide.pdf');
  });

  test('the editor says a file may be let go here, and stops saying it', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    const surface = page.locator('.nbe-editor');

    await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
      leaf.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(surface).toHaveClass(/nbe-filedrag/);

    // leaving for somewhere outside the editor ends it
    await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      leaf.dispatchEvent(
        new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body } as DragEventInit),
      );
    });
    await expect(surface).not.toHaveClass(/nbe-filedrag/);
  });

  test('and the drop itself clears it', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    await drop(page, 'notes.txt', 'text/plain');
    await expect(page.locator('.nbe-editor')).not.toHaveClass(/nbe-filedrag/);
    await expect(page.locator('.nbe-t-file')).toHaveCount(1);
  });

  test('a dropped HTML page runs, in a box that can reach nothing', async ({ page, editor }) => {
    await editor.setDocument(['une note']);
    await drop(page, 'proto.html', 'text/html', '<!doctype html><p id="x">bonjour</p>');

    const frame = page.locator('.nbe-editor iframe.nbe-file-embed');
    await expect(frame).toHaveCount(1);
    // `allow-scripts` **without** `allow-same-origin`: together they undo the
    // sandbox, apart they are exactly what a dropped prototype needs
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const sandbox = (await frame.getAttribute('sandbox')) ?? '';
    expect(sandbox).not.toContain('allow-same-origin');
    await expect.poll(async () => (await frame.getAttribute('src')) ?? '').toMatch(/^blob:/);

    // it really is the page
    await expect(page.frameLocator('iframe.nbe-file-embed').locator('#x')).toHaveText('bonjour');
    // and the download link is still there, because it is still a file
    await expect(page.locator('.nbe-file-link')).toContainText('proto.html');
    expect(editor.errors()).toEqual([]);

    /*
     * Last, because it is the one thing that *does* log: reaching into the
     * frame from here is refused, and the refusal is written to the console.
     * That message is the proof, so it cannot also be a failure.
     */
    const reachable = await page.evaluate(() => {
      const el = document.querySelector('iframe.nbe-file-embed') as HTMLIFrameElement;
      try {
        return !!el.contentDocument;
      } catch {
        return false;
      }
    });
    expect(reachable).toBe(false);
  });
});
