import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * A diagram is a code block whose language is `mermaid` — which is how every
 * Markdown tool writes one, and what this editor already parses and writes
 * back byte for byte. No new block type, no change to the file format: only a
 * feature that draws beside the source.
 */
async function diagram(page: Page, editor: { setDocument(p: string[]): Promise<void> }): Promise<void> {
  await editor.setDocument(['']);
  await page.locator('.nbe-editor .nbe-leaf').first().click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
  await page.locator('.nbe-t-code').hover();
  await page.locator('.nbe-blocktoolbar-btn').first().click();
  await page.locator('.nbe-menu [data-nbe-menu-filter]').waitFor();
  await page.keyboard.type('mermaid');
  await page.keyboard.press('Enter');
  await page.locator('.nbe-t-code .nbe-leaf').click();
  await page.keyboard.type('graph TD;');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A-->B;');
}

test.describe('mermaid diagrams', () => {
  test('a mermaid code block draws itself, outside the editable text', async ({ page, editor }) => {
    await diagram(page, editor);

    const figure = page.locator('.nbe-mermaid-figure svg');
    await expect(figure).toHaveCount(1, { timeout: 15000 });

    // the drawing is not in the leaf: the caret and the reconciler never see it
    const spans = await page.evaluate(
      () => document.querySelector('.nbe-t-code .nbe-leaf')!.querySelectorAll('*').length,
    );
    expect(spans).toBe(0);
    expect((await editor.texts())[0]).toBe('graph TD;\nA-->B;');
    expect(editor.errors()).toEqual([]);
  });

  test('the three modes show source, drawing, or both', async ({ page, editor }) => {
    await diagram(page, editor);
    await expect(page.locator('.nbe-mermaid-figure svg')).toHaveCount(1, { timeout: 15000 });

    const source = page.locator('.nbe-t-code > .nbe-row');
    const figure = page.locator('.nbe-mermaid-figure');
    await expect(source).toBeVisible();
    await expect(figure).toBeVisible();

    await page.locator('.nbe-mermaid-mode', { hasText: 'Aperçu' }).click();
    await expect(source).toBeHidden();
    await expect(figure).toBeVisible();

    await page.locator('.nbe-mermaid-mode', { hasText: 'Code' }).click();
    await expect(source).toBeVisible();
    await expect(figure).toBeHidden();

    await page.locator('.nbe-mermaid-mode', { hasText: 'Les deux' }).click();
    await expect(source).toBeVisible();
    await expect(figure).toBeVisible();
  });

  test('an ordinary code block gets no panel at all', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.type('```');
    await page.keyboard.type('const x = 1;');
    await expect(page.locator('.nbe-mermaid')).toHaveCount(0);
  });

  test('the slash menu offers a diagram directly, without the language picker', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['']);
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await editor.type('/diagramme');
    await page.locator('.nbe-slash-menu .nbe-menu-item', { hasText: 'Mermaid' }).first().waitFor();
    await editor.press('Enter');

    await expect(page.locator('.nbe-t-code')).toBeVisible();
    await expect(page.locator('.nbe-code-lang')).toHaveText('Mermaid');
    // the mode control is there before a single character is typed
    await expect(page.locator('.nbe-mermaid-modes')).toBeVisible();
  });
});
