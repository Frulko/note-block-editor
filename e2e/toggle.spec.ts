import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * A toggle's Enter goes *inside* it.
 *
 * After naming a toggle, what anyone types next is the content it hides — and
 * what they got was a second toggle, because `toggle` sat in the list of types
 * Enter continues. A second toggle is never it.
 */
const nested = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('.nbe-editor .nbe-t-toggle .nbe-block').length);

test.describe('the toggle block', () => {
  test('Enter after the summary opens it and types inside', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');
    expect(await editor.types()).toEqual(['toggle']);

    await page.keyboard.press('Enter');
    await page.keyboard.type('le contenu');

    expect(await editor.types()).toEqual(['toggle']); // one top-level block
    expect(await editor.texts()).toEqual(['Mon toggle', 'le contenu']);
    expect(await nested(page)).toBe(1);
    expect(editor.errors()).toEqual([]);
  });

  test('Shift+Tab is the way back out', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('dehors');
    expect(await nested(page)).toBe(1);

    await page.keyboard.press('Shift+Tab');
    expect(await nested(page)).toBe(0);
    expect(await editor.types()).toEqual(['toggle', 'paragraph']);
    expect(await editor.texts()).toEqual(['Mon toggle', 'dehors']);
  });

  test('a collapsed toggle opens rather than swallowing what you type', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Replié');
    await page.locator('.nbe-toggle-arrow').click();
    await editor.caret(0, 6);

    await page.keyboard.press('Enter');
    await page.keyboard.type('visible');

    await expect(page.locator('.nbe-editor .nbe-t-toggle .nbe-leaf').nth(1)).toBeVisible();
    expect(await editor.texts()).toEqual(['Replié', 'visible']);
  });

  test('splitting the summary in half moves the tail inside', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> titrecontenu');
    await editor.caret(0, 5);
    await page.keyboard.press('Enter');

    expect(await editor.texts()).toEqual(['titre', 'contenu']);
    expect(await nested(page)).toBe(1);
  });

  test('an empty toggle still escapes to a paragraph', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> ');
    expect(await editor.types()).toEqual(['toggle']);
    await page.keyboard.press('Enter');
    expect(await editor.types()).toEqual(['paragraph']);
  });
});

/**
 * Enter at the very start of a block makes room above it. The block keeps its
 * type, its text and the caret; a blank *paragraph* appears above. Splitting
 * at offset 0 gave that shape only for a paragraph — a heading handed its
 * title to a new paragraph and was left empty above it.
 */
test.describe('Enter at the start of a block', () => {
  test('a heading keeps being a heading, and keeps its title', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('# Titre');
    await editor.caret(0, 0);
    await page.keyboard.press('Enter');

    expect(await editor.types()).toEqual(['paragraph', 'heading']);
    expect(await editor.texts()).toEqual(['', 'Titre']);
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 0 });
    expect(editor.errors()).toEqual([]);
  });

  test('a list gets a blank line above it, not a stray bullet', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('- puce');
    await editor.caret(0, 0);
    await page.keyboard.press('Enter');

    expect(await editor.types()).toEqual(['paragraph', 'bulleted_list_item']);
    expect(await editor.texts()).toEqual(['', 'puce']);
  });

  test('and typing carries on where it was', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    await editor.caret(0, 0);
    await page.keyboard.press('Enter');
    await page.keyboard.type('deux ');

    expect(await editor.texts()).toEqual(['', 'deux un']);
  });

  test('Enter on an empty line still adds one below', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.press('Enter');
    expect(await editor.types()).toEqual(['paragraph', 'paragraph']);
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 0 });
  });
});

/**
 * What a toggle looks like. The arrow is drawn, not typed — a glyph inherits
 * whatever face the host set and lands at a different size in each one — and
 * an open toggle shows where its contents stop.
 */
test.describe('the toggle reads as a toggle', () => {
  test('the arrow is an icon, and it says whether it is open', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');

    const arrow = page.locator('.nbe-toggle-arrow');
    await expect(arrow.locator('svg')).toHaveCount(1);
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow).toHaveAttribute('aria-label', /.+/);

    await arrow.click();
    await expect(arrow).toHaveAttribute('aria-expanded', 'false');
    expect(editor.errors()).toEqual([]);
  });

  test('its contents are marked as held, and the summary carries more weight', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.keyboard.type('> Mon toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('dedans');

    const style = await page.evaluate(() => {
      const toggle = document.querySelector('.nbe-t-toggle')!;
      const summary = toggle.querySelector(':scope > .nbe-row > .nbe-leaf')!;
      const children = toggle.querySelector(':scope > .nbe-children')!;
      const para = document.createElement('p');
      return {
        weight: Number(getComputedStyle(summary).fontWeight),
        border: getComputedStyle(children).borderLeftWidth,
        _: para,
      };
    });
    expect(style.weight).toBeGreaterThan(400);
    expect(style.border).not.toBe('0px');
  });
});
