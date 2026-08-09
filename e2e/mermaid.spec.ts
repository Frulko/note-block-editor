import { expect, type Page } from '@playwright/test';
import { test, TOPOLOGY } from './fixtures';

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

/** Move the caret out of the editor entirely — the demo's breadcrumb will do. */
const blur = (page: Page) => page.locator('.crumbs').click({ position: { x: 2, y: 2 } });

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
    /*
     * Per-block only. Under `singleHostTopology` the editing host is the
     * editor root, so focus is never *inside* a block and "the caret is in
     * this one" stops being a DOM fact — which is what both the `:focus-within`
     * rule and `focusBlock` rest on. The mode itself still works there; what
     * cannot be expressed is the reveal-while-editing.
     */
    test.skip(TOPOLOGY !== 'per-block', 'focus lives on the root under a single host');
    await diagram(page, editor);
    await expect(page.locator('.nbe-mermaid-figure svg')).toHaveCount(1, { timeout: 15000 });

    const source = page.locator('.nbe-t-code > .nbe-row');
    const figure = page.locator('.nbe-mermaid-figure');
    await expect(source).toBeVisible();
    await expect(figure).toBeVisible();

    await page.locator('.nbe-mermaid-mode', { hasText: 'Aperçu' }).click();
    // still visible: the caret is in the block, and Aperçu does not evict it
    await expect(source).toBeVisible();
    await blur(page);
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

  test('Aperçu shows the source while the caret is in it, and hides it again', async ({
    page,
    editor,
  }) => {
    /*
     * Per-block only. Under `singleHostTopology` the editing host is the
     * editor root, so focus is never *inside* a block and "the caret is in
     * this one" stops being a DOM fact — which is what both the `:focus-within`
     * rule and `focusBlock` rest on. The mode itself still works there; what
     * cannot be expressed is the reveal-while-editing.
     */
    test.skip(TOPOLOGY !== 'per-block', 'focus lives on the root under a single host');
    await diagram(page, editor);
    await expect(page.locator('.nbe-mermaid-figure svg')).toHaveCount(1, { timeout: 15000 });
    await page.locator('.nbe-mermaid-mode', { hasText: 'Aperçu' }).click();

    const source = page.locator('.nbe-t-code > .nbe-row');
    // the caret is still in the block right after the click; it is leaving
    // that hides the source
    await blur(page);
    await expect(source).toBeHidden();

    // click the drawing to edit it: in Aperçu there is nothing else to click
    // into, and the only way back to the text used to be the Code button —
    // which, the mode being a prop, is where it then stayed
    await page.locator('.nbe-mermaid-figure').click();
    await expect(source).toBeVisible();
    await page.keyboard.type(' ');
    await expect(source).toBeVisible();

    // blur: the drawing comes back on its own
    await blur(page);
    await expect(source).toBeHidden();
    await expect(page.locator('.nbe-mermaid-figure')).toBeVisible();
    expect(editor.errors()).toEqual([]);
  });
});
