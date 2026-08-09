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

const scrollTop = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('.page-scroll')!.scrollTop);

/** Index of a block sitting comfortably inside the scrollport right now. */
async function visibleBlock(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const port = document.querySelector('.page-scroll')!.getBoundingClientRect();
    const blocks = [...document.querySelectorAll('.nbe-editor > .nbe-block')];
    return blocks.findIndex((b) => {
      const r = b.getBoundingClientRect();
      return r.top > port.top + 80 && r.bottom < port.bottom - 80;
    });
  });
}

test.describe('editing does not scroll the page', () => {
  test('Enter in a visible block leaves the scroll where it was', async ({ page, editor }) => {
    await editor.setDocument(LONG);
    await page.evaluate(() => {
      document.querySelector('.page-scroll')!.scrollTop = 600;
    });
    const before = await scrollTop(page);
    const index = await visibleBlock(page);
    expect(index).toBeGreaterThan(-1);

    await editor.caret(index, 4);
    await editor.press('Enter');

    expect(await scrollTop(page)).toBe(before);
    expect(editor.errors()).toEqual([]);
  });

  test('typing leaves the scroll where it was', async ({ page, editor }) => {
    await editor.setDocument(LONG);
    await page.evaluate(() => {
      document.querySelector('.page-scroll')!.scrollTop = 600;
    });
    const before = await scrollTop(page);
    const index = await visibleBlock(page);

    await editor.caret(index, 4);
    await editor.type('salut');

    expect(await scrollTop(page)).toBe(before);
  });

  test('reordering a block does not throw the page around', async ({ page, editor }) => {
    await editor.setDocument(LONG);
    await page.evaluate(() => {
      document.querySelector('.page-scroll')!.scrollTop = 600;
    });
    const before = await scrollTop(page);
    const index = await visibleBlock(page);

    await editor.caret(index, 0);
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
});
