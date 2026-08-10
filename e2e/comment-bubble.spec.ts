import { expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * Commenting used to go through `prompt()` — a modal the operating system
 * draws, which steals focus, cannot show what is being commented on, and is a
 * full-screen sheet on a phone. It is the editor's own floating panel now, and
 * that panel is the whole discussion: the messages already on the block, a
 * field to add one, and a bin on each to take it back.
 */

const bubble = '.nbe-comments';
const field = '.nbe-comments .nbe-comment-field';

test.describe('adding a comment', () => {
  test('opens a bubble with a textarea, and Enter sends it', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    // no dialog may appear; if one did, this listener is what proves it
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();

    await expect(page.locator(field)).toBeVisible();
    await expect(page.locator(field)).toBeFocused();

    await page.keyboard.type('mon commentaire');
    await page.keyboard.press('Enter');

    // it lands in the bubble, which stays open — a discussion is not a form
    await expect(page.locator(`${bubble} .nbe-comment-body`)).toHaveText('mon commentaire');
    await expect(page.locator('#panel-comments .message-body')).toHaveText('mon commentaire');
    expect(dialogs).toEqual([]);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape gives up without leaving a thread behind', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();
    await expect(page.locator(field)).toBeVisible();

    await page.keyboard.type('presque');
    await page.keyboard.press('Escape');

    await expect(page.locator(bubble)).toHaveCount(0);
    await expect(page.locator('#panel-comments .message-body')).toHaveCount(0);
  });

  test('a commented block carries a marker, with a count once there are two', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un bloc à commenter', 'un autre']);
    const marker = page.locator('.nbe-editor > .nbe-block').first().locator('.nbe-comment-marker');
    await expect(marker).toHaveCount(0);

    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();
    await page.locator(field).waitFor();
    await page.keyboard.type('le premier');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    // visible without hovering: move the pointer well away first
    await page.mouse.move(2, 2);
    await expect(marker).toHaveCount(1);
    await expect(marker.locator('.nbe-comment-count')).toHaveText('1');
    // and only on the block that was commented
    await expect(page.locator('.nbe-editor > .nbe-block').nth(1).locator('.nbe-comment-marker')).toHaveCount(0);

    /*
     * A second *thread*, not a second message: the first is resolved, so the
     * next comment starts a discussion of its own — which is what gives the
     * marker something to count.
     */
    await marker.click();
    await page.locator(`${bubble} .nbe-comment-btn`).first().click(); // Résoudre
    await page.locator(field).click();
    await page.keyboard.type('le second');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await page.mouse.move(2, 2);
    await expect(marker.locator('.nbe-comment-count')).toHaveText('2');
    expect(editor.errors()).toEqual([]);
  });

  test('the marker survives typing in another block', async ({ page, editor }) => {
    await editor.setDocument(['commenté', 'autre']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-controls-right .nbe-comment').click();
    await page.locator(field).waitFor();
    await page.keyboard.type('coucou');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await editor.caret(1, 5);
    await editor.type(' encore');
    await page.mouse.move(2, 2);
    await expect(page.locator('.nbe-editor .nbe-comment-marker')).toHaveCount(1);
  });
});

/**
 * The two bubbles were one bubble all along.
 *
 * @remarks
 * The marker in the margin and the hover gutter's comment button are the same
 * affordance — "talk about this block" — and they were drawn 1px apart, one
 * over the other, which read as a rendering fault. The marker is the survivor:
 * it knows how many threads there are and it is there when nobody is hovering.
 */
test.describe('one bubble in the margin, not two', () => {
  test('the hover button gives way to the marker on a commented block', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter', 'un bloc tranquille']);
    const first = page.locator('.nbe-editor > .nbe-block').first();
    const hoverButton = page.locator('.nbe-controls-right .nbe-comment');

    await first.hover();
    await expect(hoverButton).toBeVisible();
    await hoverButton.click();
    await page.locator(field).waitFor();
    await page.keyboard.type('commenté');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await first.hover();
    await expect(first.locator('.nbe-comment-marker')).toBeVisible();
    await expect(hoverButton).toBeHidden();

    // the block nobody commented still gets it, hovered
    await page.locator('.nbe-editor > .nbe-block').nth(1).hover();
    await expect(hoverButton).toBeVisible();
    expect(editor.errors()).toEqual([]);
  });
});

/**
 * What the panel is for: reading the discussion, replying to it, and removing
 * a message — none of which the composer it replaced could do.
 */
test.describe('the discussion on a block', () => {
  const openOn = async (page: import('@playwright/test').Page, index: number) => {
    const block = page.locator('.nbe-editor > .nbe-block').nth(index);
    await block.hover();
    const marker = block.locator('.nbe-comment-marker');
    if (await marker.count()) await marker.click();
    else await page.locator('.nbe-controls-right .nbe-comment').click();
    await page.locator(field).waitFor();
  };

  const say = async (page: import('@playwright/test').Page, body: string) => {
    await page.locator(field).click();
    await page.keyboard.type(body);
    await page.keyboard.press('Enter');
  };

  test('a reply joins the thread instead of starting a new one', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    await openOn(page, 0);
    await say(page, 'première question');
    await say(page, 'et la suite');

    await expect(page.locator(`${bubble} .nbe-comment-body`)).toHaveText(['première question', 'et la suite']);
    // two messages, one thread: the marker counts threads, not messages
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 2);
    await expect(page.locator('.nbe-comment-marker .nbe-comment-count')).toHaveText('1');
    expect(editor.errors()).toEqual([]);
  });

  test('reopening shows what was already said', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    await openOn(page, 0);
    await say(page, 'à relire');
    await page.keyboard.press('Escape');
    await expect(page.locator(bubble)).toHaveCount(0);

    await openOn(page, 0);
    await expect(page.locator(`${bubble} .nbe-comment-body`)).toHaveText('à relire');
  });

  test('deleting the last message takes the marker with it', async ({ page, editor }) => {
    await editor.setDocument(['un bloc à commenter']);
    await openOn(page, 0);
    await say(page, 'erreur de ma part');
    await say(page, 'non, en fait');

    await page.locator(`${bubble} .nbe-comment`).last().locator('.nbe-comment-del').click();
    await expect(page.locator(`${bubble} .nbe-comment-body`)).toHaveText('erreur de ma part');

    await page.locator(`${bubble} .nbe-comment-del`).first().click();
    await expect(page.locator(`${bubble} .nbe-comment`)).toHaveCount(0);

    // the anchor goes with the thread, or the block keeps a badge onto nothing
    await page.keyboard.press('Escape');
    await page.mouse.move(2, 2);
    await expect(page.locator('.nbe-editor .nbe-comment-marker')).toHaveCount(0);
    await expect(page.locator('#panel-comments .message-body')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});

/**
 * The panel opens beside what was pressed.
 *
 * It used to hang off the *block*, which is right for nothing: the affordance
 * is a 26px bubble in the right margin, and a panel appearing at the far
 * corner of a six-line paragraph has visibly nothing to do with it.
 */
test.describe('where the panel opens', () => {
  test('beside the margin bubble, not at the corner of the paragraph', async ({ page, editor }) => {
    await editor.setDocument([
      'un paragraphe assez long pour que son coin soit loin du bouton qui ouvre la discussion, et même un peu plus',
    ]);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-ctrl-btn.nbe-comment').click();
    await page.locator('.nbe-comment-field').waitFor();

    const gap = await page.evaluate(() => {
      const button = document.querySelector('.nbe-ctrl-btn.nbe-comment')!.getBoundingClientRect();
      const panel = document.querySelector('.nbe-comments')!.getBoundingClientRect();
      return { dx: Math.abs(panel.right - button.right), dy: Math.abs(panel.top - button.bottom) };
    });
    // within the popover's own offset of the button it was opened from
    expect(gap.dx).toBeLessThan(24);
    expect(gap.dy).toBeLessThan(24);
    expect(editor.errors()).toEqual([]);
  });
});
