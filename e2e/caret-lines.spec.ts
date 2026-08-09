import { expect, type Page } from '@playwright/test';
import { test, TOPOLOGY } from './fixtures';

/**
 * Up and down move a *line* at a time inside a block, and only leave it from
 * the first or the last one. The interesting case is the empty line: a
 * collapsed range sitting after a trailing newline reports no client rect at
 * all, and reading that as "first line and last line" sent ArrowUp out of the
 * block on the one line you are most likely to press it — the one Enter just
 * made.
 */
async function threeLines(page: Page, editor: { setDocument(p: string[]): Promise<void> }): Promise<void> {
  await editor.setDocument(['avant', '', 'apres']);
  await page.locator('.nbe-editor .nbe-leaf').nth(1).click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
  await page.keyboard.type('ligne1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ligne2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ligne3');
}

test.describe('arrows move by line inside a block', () => {
  test('up walks the lines, then leaves from the first', async ({ page, editor }) => {
    await threeLines(page, editor);
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 20 });

    await page.keyboard.press('ArrowUp');
    expect((await editor.caretAt())!.index).toBe(1);
    await page.keyboard.press('ArrowUp');
    expect((await editor.caretAt())!.index).toBe(1);
    await page.keyboard.press('ArrowUp');
    expect((await editor.caretAt())!.index).toBe(0); // out, from the first line
    expect(editor.errors()).toEqual([]);
  });

  test('down walks the lines, then leaves from the last', async ({ page, editor }) => {
    await threeLines(page, editor);
    await editor.caret(1, 0);

    await page.keyboard.press('ArrowDown');
    expect((await editor.caretAt())!.index).toBe(1);
    await page.keyboard.press('ArrowDown');
    expect((await editor.caretAt())!.index).toBe(1);
    await page.keyboard.press('ArrowDown');
    expect((await editor.caretAt())!.index).toBe(2); // out, from the last line
  });

  test('up from the empty line Enter just made stays in the block', async ({ page, editor }) => {
    /*
     * Per-block only, and the reason is the caret with no rect. Under
     * `singleHostTopology` the whole editor is one contenteditable, so when we
     * decline the key the browser's own vertical motion is free to cross into
     * the block above — and from a position it cannot measure, that is exactly
     * what it does. Fixing it there means taking over vertical movement inside
     * a block, which is a larger change than this edge deserves in a topology
     * no host currently ships.
     */
    test.skip(TOPOLOGY !== 'per-block', 'the browser owns vertical motion under a single host');
    await editor.setDocument(['avant', '', 'apres']);
    await page.locator('.nbe-editor .nbe-leaf').nth(1).click();
    await page.keyboard.type('```');
    await expect(page.locator('.nbe-t-code')).toBeVisible();
    await page.keyboard.type('ligne1');
    await page.keyboard.press('Enter');
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 7 });

    await page.keyboard.press('ArrowUp');
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 0 });
  });

  test('a wrapped line is a line too', async ({ page, editor }) => {
    await editor.setDocument(['avant', '']);
    await page.locator('.nbe-editor .nbe-leaf').nth(1).click();
    await page.keyboard.type('```');
    await page.keyboard.type('const x = ' + 'a'.repeat(300));
    const end = (await editor.caretAt())!;

    await page.keyboard.press('ArrowUp');
    const up = (await editor.caretAt())!;
    // still in the block, one visual line up — not out of it
    expect(up.index).toBe(1);
    expect(up.offset).toBeLessThan(end.offset);
    expect(up.offset).toBeGreaterThan(0);
  });
});
