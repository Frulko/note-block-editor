import { test, expect } from './fixtures';

/**
 * Clicking the empty page below the last block is how you keep writing.
 *
 * The behaviour existed but only for a click that neither moved nor landed
 * outside the editor's own box — which is not how a mouse behaves. These pin
 * the two ways it failed: a press that drifts a pixel, and a page shorter than
 * its container.
 */
test.describe('click below the last block', () => {
  const lastBlockBottom = async (page: import('@playwright/test').Page) => {
    const box = await page.locator('.nbe-editor > .nbe-block').last().boundingBox();
    return box!;
  };

  test('a click in the empty area appends one paragraph and puts the caret in it', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un', 'deux']);
    const box = await lastBlockBottom(page);
    await page.mouse.click(box.x + 40, box.y + box.height + 120);

    expect(await editor.texts()).toEqual(['un', 'deux', '']);
    expect(await editor.caretAt()).toEqual({ index: 2, offset: 0 });
    await editor.type('trois');
    expect(await editor.texts()).toEqual(['un', 'deux', 'trois']);
    expect(editor.errors()).toEqual([]);
  });

  test('a press that drifts a pixel still counts as a click', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    const box = await lastBlockBottom(page);
    const x = box.x + 40;
    const y = box.y + box.height + 120;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 1);
    await page.mouse.up();

    expect(await editor.texts()).toEqual(['un', '']);
    expect(editor.errors()).toEqual([]);
  });

  test('clicking again does not stack empty paragraphs', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    const box = await lastBlockBottom(page);
    await page.mouse.click(box.x + 40, box.y + box.height + 120);
    await page.mouse.click(box.x + 40, box.y + box.height + 160);

    expect(await editor.texts()).toEqual(['un', '']);
    expect(editor.errors()).toEqual([]);
  });

  test('clicking the margin beside a block does not append at the end', async ({ page, editor }) => {
    await editor.setDocument(['un', 'deux', 'trois']);
    const first = (await page.locator('.nbe-editor > .nbe-block').first().boundingBox())!;
    await page.mouse.click(4, first.y + first.height / 2);

    expect(await editor.texts()).toEqual(['un', 'deux', 'trois']);
  });

  test('a real drag over the empty area selects instead of appending', async ({ page, editor }) => {
    await editor.setDocument(['un', 'deux']);
    const box = await lastBlockBottom(page);
    const y = box.y + box.height + 40;
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y - 20, { steps: 8 });
    await page.mouse.up();

    expect(await editor.texts()).toEqual(['un', 'deux']);
  });
});
