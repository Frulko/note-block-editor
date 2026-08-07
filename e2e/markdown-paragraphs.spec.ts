import { test, expect } from './fixtures';

/**
 * The reported bug, in a real browser: markdown paragraph splitting and what
 * the editor then shows. Vitest proved the parser; this proves the pipeline —
 * paste goes through the clipboard, the reducer, and the reconciler before
 * anything reaches the screen, and each of those could still lose it.
 */

/**
 * Paste markdown the way a user does: as text/plain, at the caret.
 *
 * The caret must already be placed *and settled* — the model's selection is
 * what the paste inserts against, and it only catches up on the next frame.
 */
async function pasteMarkdown(page: import('@playwright/test').Page, md: string) {
  await page.evaluate((text) => {
    const leaf = document.activeElement as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    leaf.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, md);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

test.describe('markdown paragraphs reach the screen intact', () => {
  test('a wrapped paragraph pastes as one block, not one per line', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, 'Première ligne\nseconde ligne du même paragraphe.');
    const texts = await editor.texts();
    const pasted = texts.filter((t) => t.includes('ligne'));
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toBe('Première ligne seconde ligne du même paragraphe.');
    expect(editor.errors()).toEqual([]);
  });

  test('a blank line still separates paragraphs', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, 'Un.\n\nDeux.');
    const texts = await editor.texts();
    expect(texts).toContain('Un.');
    expect(texts).toContain('Deux.');
  });

  test('a construct after a paragraph starts its own block', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, 'Du texte\n# Un titre\n- un item');
    const types = await editor.types();
    expect(types).toContain('heading');
    expect(types).toContain('bulleted_list_item');
  });

  test('a hard break stays a visible line break', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, 'a\\\nb');
    const texts = await editor.texts();
    expect(texts.some((t) => t === 'a\nb')).toBe(true);
  });
});

test.describe('dynamic display follows the model', () => {
  test('typing shows what was typed, at the caret', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('Bonjour');
    const texts = await editor.texts();
    expect(texts[0]).toContain('Bonjour');
    expect(await editor.caretAt()).toMatchObject({ index: 0 });
    expect(editor.errors()).toEqual([]);
  });

  test('Enter splits into two blocks and puts the caret in the second', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('AB');
    await editor.caret(0, 1);
    await editor.press('Enter');
    const texts = await editor.texts();
    expect(texts[0]).toBe('A');
    expect(texts[1]).toBe('B');
    expect(await editor.caretAt()).toEqual({ index: 1, offset: 0 });
  });

  test('Backspace at the start merges back, caret at the seam', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('AB');
    await editor.caret(0, 1);
    await editor.press('Enter');
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('AB');
    expect(await editor.caretAt()).toEqual({ index: 0, offset: 1 });
  });

  test('markdown autoformat converts as you type', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('# ');
    expect((await editor.types())[0]).toBe('heading');
  });
});
