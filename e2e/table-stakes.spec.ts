import { test, expect } from './fixtures';

/**
 * The behaviours the survey calls table stakes.
 *
 * @remarks
 * `docs/research/competitive-landscape.md` lists what an editor must get right
 * to read as a block editor at all, and says the keyboard is "where
 * credibility is actually won". Several of those claims had no test — they
 * were implemented and assumed, which is the state the topology claim was in
 * before running it found twelve failures.
 *
 * Each test here names the specific claim it checks.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('the keyboard, where credibility is won', () => {
  test('Cmd+A escalates from the text to the block', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.press('End');

    await page.keyboard.press(`${mod}+a`);
    // first press takes the block's text; a second escalates to the block
    await page.keyboard.press(`${mod}+a`);
    await expect(page.locator('.nbe-block.nbe-selected').first()).toBeVisible();
    expect(editor.errors()).toEqual([]);
  });

  test('Escape selects the block, and Escape again clears it', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc']);
    await page.locator('.nbe-leaf').first().click();

    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-block.nbe-selected')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-block.nbe-selected')).toHaveCount(0);
  });

  test('autoformat undoes back to the literal text in one step', async ({ page, editor }) => {
    // the survey is explicit: one Cmd+Z, not two. Two means the conversion and
    // the typing were separate transactions, and the user sees a stutter.
    await editor.setDocument(['']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.type('# ');
    expect((await editor.types())[0]).toBe('heading');

    await page.keyboard.press(`${mod}+z`);
    expect((await editor.types())[0]).toBe('paragraph');
    expect((await editor.texts())[0]).toBe('# ');
  });

  test('deleting the last block leaves a paragraph, never an empty document', async ({ page, editor }) => {
    await editor.setDocument(['seul']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    // an empty document has no caret to put anywhere, which is unrecoverable
    await expect(page.locator('.nbe-leaf')).toHaveCount(1);
    expect((await editor.types())[0]).toBe('paragraph');
  });

  test('moving a block by keyboard goes through the same path as dragging it', async ({ page, editor }) => {
    /*
     * The survey warns these disagree at the edges when they are two
     * implementations. Both call `moveBlocksVertical`, so this checks the
     * observable consequence: moving down then up returns the document exactly.
     */
    await editor.setDocument(['un', 'deux', 'trois']);
    await page.locator('.nbe-leaf').first().click();
    const before = await editor.texts();

    await page.keyboard.press(`${mod}+Shift+ArrowDown`);
    expect((await editor.texts())[0]).toBe('deux');
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    expect(await editor.texts()).toEqual(before);
  });
});

test.describe('the slash menu opens only when asked', () => {
  test('a typed slash opens it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.type('/');
    await expect(page.locator('.nbe-menu')).toBeVisible();
  });

  test('a pasted slash does not', async ({ page, editor }) => {
    // the survey names paste, undo and programmatic insertion specifically
    await editor.setDocument(['']);
    await page.locator('.nbe-leaf').first().click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'chemin/vers/un fichier');
      document.querySelector('.nbe-leaf')!.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(200);
    await expect(page.locator('.nbe-menu')).toHaveCount(0);
  });

  test('Escape closes it without eating the typed text', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.type('/head');
    await expect(page.locator('.nbe-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-menu')).toHaveCount(0);
    expect((await editor.texts())[0]).toBe('/head');
  });

  test('Enter converts in place and leaves the caret in the new block', async ({ page, editor }) => {
    // with a block following it, the caret used to land on that one instead
    await editor.setDocument(['one', '', 'three']);
    await editor.caret(1, 0);
    await page.keyboard.type('/head');
    await expect(page.locator('.nbe-menu')).toBeVisible();
    await page.keyboard.press('Enter');
    expect(await editor.types()).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 0 });
  });
});
