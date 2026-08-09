import { test, expect } from './fixtures';

/**
 * The page must not move under the person writing on it.
 *
 * Every edit re-asserts the caret, and re-asserting it used to call
 * `Element.scrollIntoView` unconditionally — which scrolls *every* scrollable
 * ancestor, including ones the editor does not own. Inside a host with its own
 * scroller (Obsidian's pane, this demo's `.page-scroll`) that reads as the page
 * jumping on Enter, and on a reorder.
 */
const LONG = Array.from({ length: 60 }, (_, i) => `paragraphe ${i}`);

/** The block the caret is in, roughly centred, with the scroll left there. */
const CARET_AT = 30;

const scrollTop = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('.page-scroll')!.scrollTop);

/**
 * Put the caret in a block and scroll so that block sits mid-viewport.
 *
 * Order matters: placing the caret focuses the editing host, and under the
 * single-host topology that host is the editor root — which the browser scrolls
 * to. So the scroll is set *after*, and the number read after that.
 */
async function settle(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
  await editor.setDocument(LONG);
  await editor.caret(CARET_AT, 4);
  await page.evaluate((index) => {
    const scroller = document.querySelector('.page-scroll')!;
    const block = document.querySelectorAll('.nbe-editor > .nbe-block')[index]!;
    const port = scroller.getBoundingClientRect();
    scroller.scrollTop += block.getBoundingClientRect().top - port.top - port.height / 2;
  }, CARET_AT);
  return scrollTop(page);
}

test.describe('editing does not scroll the page', () => {
  test('Enter in a visible block leaves the scroll where it was', async ({ page, editor }) => {
    const before = await settle(page, editor);
    await editor.press('Enter');

    expect(await scrollTop(page)).toBe(before);
    expect(editor.errors()).toEqual([]);
  });

  test('typing leaves the scroll where it was', async ({ page, editor }) => {
    const before = await settle(page, editor);
    await editor.type('salut');

    expect(await scrollTop(page)).toBe(before);
    expect(await editor.texts()).toContain('parasalutgraphe 30');
  });

  test('reordering a block does not throw the page around', async ({ page, editor }) => {
    const before = await settle(page, editor);
    await editor.press('Meta+Shift+ArrowDown');

    expect(await scrollTop(page)).toBe(before);
  });

  test('the caret still comes back into view when it is genuinely off screen', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(LONG);
    await editor.caret(0, 0);
    await page.evaluate(() => {
      document.querySelector('.page-scroll')!.scrollTop = 2000;
    });
    // an edit at a caret nobody can see must bring it back
    await editor.press('Enter');

    const visible = await page.evaluate(() => {
      const port = document.querySelector('.page-scroll')!.getBoundingClientRect();
      const node = document.getSelection()?.focusNode;
      const el = (node?.nodeType === 1 ? node : node?.parentElement) as Element | null;
      const leaf = el?.closest('.nbe-leaf')?.getBoundingClientRect();
      return !!leaf && leaf.bottom > port.top && leaf.top < port.bottom;
    });
    expect(visible).toBe(true);
  });

  test('the format toolbar is clipped by the editor, not by the window', async ({ page, editor }) => {
    await editor.setDocument(Array.from({ length: 60 }, (_, i) => `paragraphe numero ${i}`));
    await editor.selectRange([3, 0], [3, 9]);
    const bar = page.locator('.nbe-seltoolbar');
    await expect(bar).toBeVisible();

    const above = await page.evaluate(() => {
      const b = document.querySelector('.nbe-seltoolbar')!.getBoundingClientRect();
      const port = document.querySelector('.page-scroll')!.getBoundingClientRect();
      return b.top >= port.top;
    });
    expect(above).toBe(true);

    // scroll the selection away: the bar is portaled to <body>, so nothing
    // clips it — it used to pin itself to the top of the window, over the host
    await page.evaluate(() => (document.querySelector('.page-scroll')!.scrollTop = 600));
    await expect(bar).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });

  test('dropping a dragged block does not chase a caret left elsewhere', async ({ page, editor }) => {
    await editor.setDocument(Array.from({ length: 50 }, (_, i) => `paragraphe ${i}`));
    // a caret left far down the page, then scrolled back to the top
    await editor.caret(49, 3);
    await page.evaluate(() => (document.querySelector('.page-scroll')!.scrollTop = 0));
    const before = await scrollTop(page);
    expect(before).toBe(0);

    const target = (await page.locator('.nbe-editor > .nbe-block').nth(4).boundingBox())!;
    await page.locator('.nbe-editor > .nbe-block').nth(1).hover();
    const handle = (await page.locator('.nbe-handle').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + target.height, { steps: 10 });
    await page.mouse.up();

    // the block moved…
    await expect.poll(async () => (await editor.texts())[0]).toBe('paragraphe 0');
    expect((await editor.texts()).slice(0, 5)).toEqual([
      'paragraphe 0',
      'paragraphe 2',
      'paragraphe 3',
      'paragraphe 4',
      'paragraphe 1',
    ]);
    // …and the page stayed where the person was looking
    expect(await scrollTop(page)).toBe(before);
    expect(editor.errors()).toEqual([]);
  });
});
