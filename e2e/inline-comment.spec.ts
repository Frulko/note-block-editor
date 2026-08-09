import { test, expect } from './fixtures';

/**
 * A comment on a sentence, not on a paragraph.
 *
 * Comments started out anchored to the whole block, which was the right first
 * shape and too narrow: the thing people argue about is usually one sentence.
 * The mark and the yellow highlight were already there — the stylesheet has
 * drawn `.nbe-m-comment` with `cursor: pointer` since comments shipped and
 * nothing was listening, because the mark's `threadId` never reached the DOM.
 */

/**
 * Select characters `from`–`to` of the first block.
 *
 * The fixture's `selectRange` reaches for the leaf's `firstChild`, which is
 * the whole text only until something is marked — after the first comment the
 * leaf holds several nodes, and the second selection has to walk them.
 */
async function selectChars(page: import('@playwright/test').Page, from: number, to: number) {
  await page.evaluate(
    ({ from, to }) => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
      const at = (target: number): [Node, number] => {
        let seen = 0;
        walker.currentNode = leaf;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const len = n.textContent?.length ?? 0;
          if (seen + len >= target) return [n, target - seen];
          seen += len;
        }
        return [leaf, 0];
      };
      const [an, ao] = at(from);
      const [hn, ho] = at(to);
      document.getSelection()!.setBaseAndExtent(an, ao, hn, ho);
    },
    { from, to },
  );
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** Select some words and open the composer from the format toolbar. */
async function commentOn(
  page: import('@playwright/test').Page,
  editor: import('./fixtures').Editor,
  from: number,
  to: number,
) {
  await selectChars(page, from, to);
  await page.locator('.nbe-seltoolbar-comment').click();
  await page.locator('.nbe-comment-field').waitFor();
}

async function send(page: import('@playwright/test').Page, body: string) {
  await page.locator('.nbe-comment-field').fill(body);
  await page.locator('.nbe-comment-field').press('Enter');
}

/** The text each yellow highlight covers, in order. */
const highlights = (page: import('@playwright/test').Page) =>
  page.locator('.nbe-editor .nbe-m-comment').allTextContents();

test.describe('commenting a selection', () => {
  test('the highlight covers what was selected, and nothing else', async ({ page, editor }) => {
    await editor.setDocument(['une phrase entière dans un paragraphe']);
    await commentOn(page, editor, 4, 11);
    await send(page, 'celui-ci');

    await expect.poll(() => highlights(page)).toEqual(['phrase ']);
    expect(editor.errors()).toEqual([]);
  });

  test('clicking the highlight reopens that discussion', async ({ page, editor }) => {
    await editor.setDocument(['une phrase entière dans un paragraphe']);
    await commentOn(page, editor, 4, 11);
    await send(page, 'première remarque');
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-comment-field')).toHaveCount(0);

    await page.locator('.nbe-editor .nbe-m-comment').click();
    await expect(page.locator('.nbe-comment-body')).toHaveText('première remarque');
    expect(editor.errors()).toEqual([]);
  });

  test('two comments on one paragraph stay two discussions', async ({ page, editor }) => {
    await editor.setDocument(['une phrase entière dans un paragraphe']);
    await commentOn(page, editor, 4, 11);
    await send(page, 'sur phrase');
    await page.keyboard.press('Escape');

    await commentOn(page, editor, 27, 37);
    await send(page, 'sur paragraphe');
    await page.keyboard.press('Escape');

    await expect.poll(() => highlights(page)).toEqual(['phrase ', 'paragraphe']);
    // clicking one shows one: a block's whole correspondence is the gutter's job
    await page.locator('.nbe-editor .nbe-m-comment').first().click();
    await expect(page.locator('.nbe-comment-body')).toHaveText('sur phrase');
  });

  test('the button is absent when the selection spans blocks', async ({ page, editor }) => {
    // one comment, two anchors is a different feature and not this one
    await editor.setDocument(['premier paragraphe', 'second paragraphe']);
    await editor.selectRange([0, 3], [1, 6]);
    await expect(page.locator('.nbe-seltoolbar')).toBeVisible();
    await expect(page.locator('.nbe-seltoolbar-comment')).toBeHidden();
  });
});
