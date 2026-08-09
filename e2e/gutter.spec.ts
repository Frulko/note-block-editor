import { test, expect } from './fixtures';

/**
 * The hover gutter stays where it belongs.
 *
 * @remarks
 * Reported 2026-08-07 with a screenshot of the + and ⋮⋮ buttons floating in
 * the host page, left of the editor card. Three symptoms, one cause: the
 * gutter was mounted on `document.body` and positioned in viewport
 * coordinates, so it did not follow the editor's own scrolling, it was placed
 * once on hover and never updated, and nothing kept it inside the editor when
 * the host was narrower than the gutter is wide.
 *
 * It now lives inside `view.content`, in the margin the page geometry reserves
 * for it. These pin all three.
 */

/** Where the gutter is, relative to the editor box and to its block. */
async function gutter(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const editor = document.querySelector('.nbe-editor')!;
    const el = document.querySelector('.nbe-controls') as HTMLElement | null;
    if (!el || !el.isConnected) return null;
    const e = editor.getBoundingClientRect();
    const g = el.getBoundingClientRect();
    const nearest = [...document.querySelectorAll('.nbe-editor > .nbe-block')]
      .map((b) => ({ text: b.textContent ?? '', top: b.getBoundingClientRect().top }))
      .reduce((best, b) => (Math.abs(b.top - g.top) < Math.abs(best.top - g.top) ? b : best));
    return {
      insideEditor: g.left >= e.left - 0.5 && g.right <= e.right + 0.5,
      insideDom: editor.contains(el),
      top: g.top,
      offsetFromBlock: g.top - nearest.top,
      blockText: nearest.text,
    };
  });
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `bloc numero ${i}`);

test.describe('the gutter belongs to the editor', () => {
  test('it is mounted inside the editor, not in the host page', async ({ page, editor }) => {
    await editor.setDocument(lines(6));
    const box = (await page.locator('.nbe-editor > .nbe-block').nth(2).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);
    const g = (await gutter(page))!;
    expect(g.insideDom).toBe(true);
    expect(g.insideEditor).toBe(true);
  });

  test('it never spills past the editor edge', async ({ page, editor }) => {
    await editor.setDocument(lines(6));
    for (const i of [0, 2, 5]) {
      const box = (await page.locator('.nbe-editor > .nbe-block').nth(i).boundingBox())!;
      await page.mouse.move(box.x + 60, box.y + box.height / 2);
      await page.waitForTimeout(150);
      expect((await gutter(page))?.insideEditor).toBe(true);
    }
  });

  test('it stays beside the block under the cursor when the page scrolls', async ({ page, editor }) => {
    await editor.setDocument(lines(50));
    const box = (await page.locator('.nbe-editor > .nbe-block').nth(3).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);
    const before = (await gutter(page))!;

    /*
     * Scroll the container that actually scrolls. `mouse.wheel` moves
     * `.page-scroll` on Chromium and moves nothing on WebKit, and this test is
     * about the gutter, not about wheel dispatch.
     */
    await page.evaluate(() => {
      const scroller = document.querySelector('.page-scroll');
      if (!scroller) throw new Error('.page-scroll introuvable — le démonstrateur a changé');
      scroller.scrollTop += 300;
    });
    await page.waitForTimeout(250);
    const after = (await gutter(page))!;

    /*
     * The gutter belongs to the block you are *pointing at*, so with the cursor
     * still it stays put on screen and re-targets whatever scrolled under it.
     *
     * This used to assert the opposite — that it rode the content upwards,
     * keeping the same block. That let it end up at `top: -82`, above the
     * viewport, decorating nothing. Chromium passed and WebKit did not, purely
     * because WebKit re-fires the hover on a programmatic scroll; the editor
     * now does that itself on both.
     */
    expect(Math.abs(after.top - before.top)).toBeLessThan(24);
    expect(after.blockText).not.toBe(before.blockText);
    // and it is genuinely beside its new block, not merely parked
    expect(Math.abs(after.offsetFromBlock - before.offsetFromBlock)).toBeLessThan(2);
  });

  test('the buttons still work from inside the content', async ({ page, editor }) => {
    // it now sits in the editing host, so it must be inert to input
    await editor.setDocument(['premier', 'deuxieme']);
    const box = (await page.locator('.nbe-editor > .nbe-block').nth(0).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await page.locator('.nbe-plus').click();
    await page.waitForTimeout(150);
    expect((await editor.texts()).length).toBe(3);
    expect(editor.errors()).toEqual([]);
  });

  test('its text is not part of the document', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme']);
    const box = (await page.locator('.nbe-editor > .nbe-block').nth(0).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);
    expect(await editor.texts()).toEqual(['premier', 'deuxieme']);
  });
});

/**
 * The right-hand gutter, and the comment it opens.
 *
 * @remarks
 * The demo wires `onComment` to a thread store and a panel, so this drives the
 * whole path the way a user does: hover a block, click the bubble, type, and
 * find the thread anchored to the block it was opened on. The mark laid over
 * the block's text is what makes the anchor survive editing, so it is asserted
 * rather than assumed.
 */
test.describe('the right gutter comments on a block', () => {
  test('the bubble appears beside the block, opposite the handle', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme']);
    const box = (await page.locator('.nbe-editor > .nbe-block').nth(0).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);

    const sides = await page.evaluate(() => {
      const left = document.querySelector('.nbe-plus')?.getBoundingClientRect().left;
      const right = document.querySelector('.nbe-comment')?.getBoundingClientRect().left;
      const block = document.querySelector('.nbe-editor > .nbe-block')!.getBoundingClientRect();
      return { left, right, blockLeft: block.left, blockRight: block.right };
    });
    expect(sides.left!).toBeLessThan(sides.blockLeft);
    expect(sides.right!).toBeGreaterThanOrEqual(sides.blockRight);
  });

  test('it creates a thread, anchored by a mark on the block', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'deuxieme']);
    // no `prompt()` any more: the comment is composed in the editor's own
    // floating panel, so a dialog appearing at all would be the regression
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    const box = (await page.locator('.nbe-editor > .nbe-block').nth(0).boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await page.locator('.nbe-comment').click();
    await expect(page.locator('.comment-compose .compose-field')).toBeFocused();
    await page.keyboard.type('à revoir');
    await page.keyboard.press('Enter');

    // the anchor is the mark, and it covers the block's whole text
    await expect(page.locator('.nbe-editor > .nbe-block').nth(0).locator('.nbe-m-comment')).toHaveText('premier');

    await page.locator('[data-tab="comments"]').click();
    await expect(page.locator('#panel-comments .thread')).toHaveCount(1);
    await expect(page.locator('#panel-comments .message-body')).toHaveText('à revoir');
    expect(dialogs).toEqual([]);
    expect(editor.errors()).toEqual([]);
  });
});
