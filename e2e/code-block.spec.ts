import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * The code block, and specifically the claim its design rests on: **the
 * colours are painted, not marked up**. If a highlighter ever starts inserting
 * spans into the leaf, the caret, the IME and the DOM→model reconciler all
 * inherit a problem — so the invariant is asserted directly, in the browser,
 * rather than trusted.
 */

async function makeCode(page: Page, editor: { setDocument(p: string[]): Promise<void> }): Promise<void> {
  await editor.setDocument(['']);
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
}

/** Painted ranges, by highlight name — the CSS Custom Highlight registry. */
const painted = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const [name, highlight] of (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights) {
      if (name.startsWith('nbe-code-')) out[name] = highlight.size;
    }
    return out;
  });

test.describe('the code block', () => {
  test('``` opens one, from the plugin\'s own shortcut', async ({ page, editor }) => {
    await makeCode(page, editor);
    expect(await editor.types()).toEqual(['code']);
    expect(editor.errors()).toEqual([]);
  });

  test('colours the code without putting a single span in the leaf', async ({ page, editor }) => {
    await makeCode(page, editor);
    // pick a language, then type into it
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('javas');
    await page.locator('.nbe-menu button', { hasText: 'JavaScript' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('const x = 1;');

    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(1);
    const ranges = await painted(page);
    expect(ranges['nbe-code-keyword']).toBeGreaterThan(0);

    // the invariant: the leaf still holds plain text nodes and nothing else
    const markup = await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-t-code .nbe-leaf')!;
      return { spans: leaf.querySelectorAll('*').length, text: leaf.textContent };
    });
    expect(markup.spans).toBe(0);
    expect(markup.text).toBe('const x = 1;');
    expect(editor.errors()).toEqual([]);
  });

  test('Enter adds a line instead of splitting the block', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Enter');
    await page.keyboard.type('deux');
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('un\ndeux');
    expect(editor.errors()).toEqual([]);
  });

  test('Tab indents, Shift+Tab outdents — it never leaves the block', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    expect((await editor.texts())[0]).toBe('  x');
    await page.keyboard.press('Shift+Tab');
    expect((await editor.texts())[0]).toBe('x');
    expect(await editor.types()).toEqual(['code']);
    expect(editor.errors()).toEqual([]);
  });

  test('the caret survives typing in coloured code', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('python');
    await page.locator('.nbe-menu button', { hasText: 'Python' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('def f():');
    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(0);
    // typing continues where the caret was, which is the whole point of not
    // rewriting the DOM to colour it
    await page.keyboard.type(' pass');
    expect((await editor.texts())[0]).toBe('def f(): pass');
    expect(editor.errors()).toEqual([]);
  });

  test('Shift+Enter adds a line too — both spellings of "new line"', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('deux');
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('un\ndeux');
  });
});

/**
 * The clipboard, which the extraction into `@nbe/blocks-code` broke in both
 * directions: the copy path serialised through Markdown with no plugin
 * registry, and the paste path ran the Markdown parser over text going *into*
 * a block that holds literal characters.
 */
test.describe('the code block and the clipboard', () => {
  test('copying it puts the code on the clipboard, not a placeholder', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1;');
    await page.keyboard.press('ControlOrMeta+a');

    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return { plain: dt.getData('text/plain'), html: dt.getData('text/html') };
    });
    expect(copied.plain).toContain('const x = 1;');
    expect(copied.plain).not.toContain('nbe:code'); // the "cannot say it" marker
    expect(copied.html).toContain('<pre><code>const x = 1;</code></pre>');
  });

  test('pasting into it inserts text, and does not parse Markdown', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '#!/bin/sh\n# setup\necho ok');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });

    // one block, still code, `#` intact — it used to become a heading
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('#!/bin/sh\n# setup\necho ok');
    expect(editor.errors()).toEqual([]);
  });

  test('the language filter keeps the focus while you type in it', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    const input = page.locator('.nbe-menu input');
    await input.click();
    // one character at a time: `fill()` sets the value in one shot and would
    // never have caught this — it took one character per click
    await page.keyboard.type('jav', { delay: 20 });

    await expect(input).toHaveValue('jav');
    await expect(input).toBeFocused();
    await expect(page.locator('.nbe-menu button', { hasText: 'JavaScript' })).toBeVisible();
  });
});
