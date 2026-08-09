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
    // the editable host, whichever topology is running
    const host =
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[contenteditable]') ??
      document.querySelector<HTMLElement>('.nbe-editor [contenteditable], .nbe-editor[contenteditable]')!;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
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

  test('inline **bold** converts as you type, and the next character stays plain', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('say **gras** x');
    expect((await editor.texts())[0]).toBe('say gras x');
    expect(await page.locator('.nbe-editor .nbe-m-bold').allTextContents()).toEqual(['gras']);
    expect(editor.errors()).toEqual([]);
  });

  test('inline `code` converts inside a list item', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('- run `ls -la`');
    expect((await editor.types())[0]).toBe('bulleted_list_item');
    expect(await page.locator('.nbe-editor .nbe-m-code').allTextContents()).toEqual(['ls -la']);
  });

  /*
   * On a French AZERTY or US-International layout ` is a dead key, so it never
   * arrives as `insertText` — the browser composes it and commits at
   * `compositionend`. Synthetic key events skip composition entirely, which is
   * why the test above passed while both backtick rules were dead on a real
   * keyboard. This one commits the text the way a dead key does.
   */
  test('a dead-key backtick still converts', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-editor .nbe-leaf')!;
      leaf.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      leaf.textContent = '`ls -la`';
      const range = document.createRange();
      range.selectNodeContents(leaf);
      range.collapse(false);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      leaf.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '`' }));
    });
    expect(await page.locator('.nbe-editor .nbe-m-code').allTextContents()).toEqual(['ls -la']);
    expect((await editor.texts())[0]).toBe('ls -la');
  });
});

/**
 * The same wrapping rule, applied to list items — reported from
 * docs/ARCHITECTURE.md §12 on 2026-08-07: every item rendered as "1." and each
 * item's continuation lines sat under it as a stray paragraph. One cause: the
 * DOM's `listNumber` counts *consecutive* siblings, and those paragraphs were
 * sitting between the items.
 */
test.describe('a pasted numbered list numbers itself', () => {
  const md = [
    '1. **Storage runtime/platform.** Browser (OPFS/File System Access) vs',
    '   Tauri/Electron vs CLI; atomic temp+rename writes, debounced saves.',
    '2. **Binary asset pipeline.** Where blobs live across L0/L1/L2,',
    '   content-hash dedup, reference counting.',
    '3. **Unicode correctness.** Grapheme clusters, surrogate pairs.',
  ].join('\n');

  test('renders 1, 2, 3 — not 1, 1, 1', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, md);
    expect(await page.locator('.nbe-editor .nbe-number').allTextContents()).toEqual(['1.', '2.', '3.']);
    expect(editor.errors()).toEqual([]);
  });

  test('keeps each item whole, with no paragraph between them', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await pasteMarkdown(page, md);
    const types = await editor.types();
    expect(types.filter((t) => t !== 'paragraph')).toEqual([
      'numbered_list_item',
      'numbered_list_item',
      'numbered_list_item',
    ]);
    const texts = await editor.texts();
    expect(texts[0]).toContain('debounced saves.');
    expect(texts[0]).not.toContain('\n');
  });
});
