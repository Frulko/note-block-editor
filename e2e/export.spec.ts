import { expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * `⌘P` offers what the page can become. Off by default — that key is the
 * browser's print dialog, and a page that takes it had better be offering more
 * than a worse one, which is why printing is one of the four things on the
 * menu rather than the thing it replaces.
 */
test.describe('export', () => {
  test('Cmd/Ctrl+P offers the formats, and Markdown downloads the document', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['# Titre', 'du texte']);
    await page.goto('/?export=on');
    await page.locator('.nbe-editor .nbe-leaf').first().click();

    await page.keyboard.press('ControlOrMeta+p');
    const menu = page.locator('.nbe-export-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.nbe-menu-item')).toHaveText([
      /Markdown/,
      /Texte/,
      /PDF/,
      /HTML/,
    ]);

    const download = page.waitForEvent('download');
    await menu.locator('.nbe-menu-item', { hasText: 'Markdown' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    expect(editor.errors()).toEqual([]);
  });

  test('the Markdown it writes is the document, plugins included', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.goto('/?export=on');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.type('```');
    await expect(page.locator('.nbe-t-code')).toBeVisible();
    await page.keyboard.type('const x = 1;');

    const download = page.waitForEvent('download');
    await page.keyboard.press('ControlOrMeta+p');
    await page.locator('.nbe-export-menu .nbe-menu-item', { hasText: 'Markdown' }).click();
    const stream = await (await download).createReadStream();
    const text = await new Response(stream as unknown as ReadableStream).text();

    // a fence, not the `<!-- nbe:code -->` marker a missing registry produces
    expect(text).toContain('```');
    expect(text).toContain('const x = 1;');
  });

  test('it is off unless a host asks for it', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    await page.goto('/');
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.locator('.nbe-export-menu')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});
