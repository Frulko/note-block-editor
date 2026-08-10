import { test, expect } from './fixtures';

/**
 * The format bar in its older shape: pinned above the note.
 *
 * @remarks
 * Same bar, same seven marks, same sub-menus — three things differ, and only
 * three are worth a browser to check. It is there before anything is selected,
 * it stays there after the selection is gone, and with a caret that has
 * selected nothing the mark buttons are *disabled* rather than silently doing
 * nothing.
 *
 * That last one is the decision. A pinned bar is looked at all the time, so
 * "nothing is selected" needs an answer; applying to what you type next is a
 * pending-format state the model does not have, and applying to the word under
 * the caret is a guess. Saying so is the honest third option.
 */
const url = '/?toolbar=sticky';

test.describe('the pinned format toolbar', () => {
  test('is there before anything is selected', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    const bar = page.locator('.nbe-seltoolbar-sticky');
    await expect(bar).toHaveCount(1);
    // above the content, not floating over it
    const inSlot = await bar.evaluate((el) => !!el.closest('.nbe-slot-top'));
    expect(inSlot).toBe(true);
  });

  test('its mark buttons are disabled with nothing selected, and live with', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    const bold = page.locator('.nbe-seltoolbar-sticky .nbe-fmt-bold');
    await expect(bold).toBeDisabled();

    await editor.selectRange([0, 0], [0, 7]);
    await expect(bold).toBeEnabled();
  });

  test('it applies a mark to the selection, like the floating one', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.locator('.nbe-seltoolbar-sticky .nbe-fmt-bold').click();

    await expect(page.locator('.nbe-editor .nbe-m-bold')).toHaveText('bonjour');
    expect(await editor.texts()).toEqual(['bonjour monde']); // a mark, not an edit
    expect(editor.errors()).toEqual([]);
  });

  test('« Transformer en » stays live on a caret — a block needs no selection', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    await page.locator('.nbe-seltoolbar-sticky .nbe-seltoolbar-turn').click();
    await page.locator('.nbe-seltoolbar-menu .nbe-menu-item', { hasText: 'Titre 1' }).first().click();
    await expect(page.locator('.nbe-editor .nbe-t-heading')).toHaveCount(1);
    expect(editor.errors()).toEqual([]);
  });

  test('and the floating one is not also there', async ({ page, editor }) => {
    await page.goto(url);
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.waitForTimeout(200);
    // one bar, and it is the pinned one: two offering the same seven marks,
    // one hovering over the other, is not a configuration anyone chose
    await expect(page.locator('.nbe-seltoolbar')).toHaveCount(1);
    await expect(page.locator('.nbe-seltoolbar-sticky')).toHaveCount(1);
  });

  test('the default is still the floating bar', async ({ page, editor }) => {
    await page.goto('/');
    await editor.setDocument(['bonjour monde']);
    await expect(page.locator('.nbe-seltoolbar-sticky')).toHaveCount(0);
    await editor.selectRange([0, 0], [0, 7]);
    await expect(page.locator('.nbe-seltoolbar')).toHaveCount(1);
  });
});

/**
 * The classic editor: a page of text with a bar over it.
 *
 * @remarks
 * There is no turning the blocks *off* — the document is blocks, and a mode
 * that changed that would be a second editor sharing a name. What is turned
 * off is every affordance that makes them visible, plus the topology: the
 * whole document becomes one `contenteditable`, which is what a classic editor
 * *is* and what makes the browser's own selection behave the way someone
 * coming from one expects.
 *
 * So the test is mostly a list of things that must be absent, and one that
 * must not be: typing, formatting and the Markdown autoformat all still work,
 * because none of that is block chrome.
 */
test.describe('the classic editor', () => {
  const classic = '/?mode=classic';

  test('has no gutter, no slash menu and no block bar', async ({ page, editor }) => {
    await page.goto(classic);
    await editor.setDocument(['bonjour monde', 'seconde ligne']);
    const box = (await page.locator('.nbe-editor > .nbe-block').first().boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.waitForTimeout(200);
    await expect(page.locator('.nbe-controls')).toHaveCount(0);

    await editor.caret(1, 13);
    await editor.type('/');
    await page.waitForTimeout(200);
    await expect(page.locator('.nbe-menu')).toHaveCount(0);
    // the slash is text now, not a trigger
    expect(await editor.texts()).toEqual(['bonjour monde', 'seconde ligne/']);
  });

  test('is one editing host, not one per block', async ({ page, editor }) => {
    await page.goto(classic);
    await editor.setDocument(['bonjour monde', 'seconde ligne']);
    /*
     * `plaintext-only`, not `true` — that is the single-host topology's own
     * choice and the reason it is safe: it stops the browser inserting markup
     * of its own into a surface the model has to be able to read back.
     */
    const hosts = await page.evaluate(() =>
      [...document.querySelectorAll('.nbe-editor, .nbe-leaf')].filter(
        (el) => (el.getAttribute('contenteditable') ?? 'false') !== 'false',
      ).map((el) => el.className),
    );
    expect(hosts).toEqual(['nbe-editor']);
  });

  test('still types, formats and autoformats — none of that is block chrome', async ({ page, editor }) => {
    await page.goto(classic);
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('## un titre\n');
    await expect(page.locator('.nbe-editor .nbe-t-heading')).toHaveCount(1);

    await editor.type('gras ici');
    await editor.selectRange([1, 0], [1, 4]);
    await page.locator('.nbe-seltoolbar-sticky .nbe-fmt-bold').click();
    await expect(page.locator('.nbe-editor .nbe-m-bold')).toHaveText('gras');
    expect(editor.errors()).toEqual([]);
  });
});
