import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * A menu you filter by typing is a combobox, and a combobox is usable without
 * a mouse. `createMenu` deliberately leaves form controls alone — a formula
 * editor's Enter is its own — which meant the language picker's Enter reached
 * nobody: you could type to filter and then had to click.
 */
async function openLanguagePicker(page: Page, editor: { setDocument(p: string[]): Promise<void> }) {
  await editor.setDocument(['']);
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
  await page.locator('.nbe-t-code').hover();
  await page.locator('.nbe-blocktoolbar-btn').first().click();
  await expect(page.locator('.nbe-menu [data-nbe-menu-filter]')).toBeFocused();
}

test.describe('a filtered menu is keyboard-first', () => {
  test('type to filter, Enter to choose — no mouse anywhere', async ({ page, editor }) => {
    await openLanguagePicker(page, editor);
    await page.keyboard.type('pyth');
    await expect(page.locator('.nbe-menu-item')).toHaveText(['Python']);

    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-menu')).toHaveCount(0);
    await expect(page.locator('.nbe-code-lang')).toHaveText('Python');
    expect(editor.errors()).toEqual([]);
  });

  test('the arrows move the highlight, and Enter takes it', async ({ page, editor }) => {
    await openLanguagePicker(page, editor);
    await page.keyboard.type('s');
    const items = await page.locator('.nbe-menu-item').allTextContents();
    expect(items.length).toBeGreaterThan(2);

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.nbe-menu .nbe-active')).toHaveText(items[1]!);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.nbe-menu .nbe-active')).toHaveText(items[1]!);

    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-code-lang')).toHaveText(items[1]!);
  });

  test('it announces the highlighted option while focus stays in the field', async ({
    page,
    editor,
  }) => {
    await openLanguagePicker(page, editor);
    await page.keyboard.type('ru');
    const aria = await page.evaluate(() => {
      const input = document.querySelector('[data-nbe-menu-filter]')!;
      const active = document.querySelector('.nbe-menu .nbe-active');
      return {
        role: input.getAttribute('role'),
        autocomplete: input.getAttribute('aria-autocomplete'),
        controls: input.getAttribute('aria-controls'),
        activedescendant: input.getAttribute('aria-activedescendant'),
        activeId: active?.id ?? null,
      };
    });
    expect(aria.role).toBe('combobox');
    expect(aria.autocomplete).toBe('list');
    expect(aria.controls).toBeTruthy();
    expect(aria.activedescendant).toBe(aria.activeId);
  });

  test('typing still goes to the field, not to the document', async ({ page, editor }) => {
    await openLanguagePicker(page, editor);
    await page.keyboard.type('rust', { delay: 15 });
    await expect(page.locator('[data-nbe-menu-filter]')).toHaveValue('rust');
    expect((await editor.texts())[0]).toBe('');
  });
});
