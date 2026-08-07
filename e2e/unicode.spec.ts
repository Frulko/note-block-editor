import { test, expect } from './fixtures';

/**
 * AQ#4 — one press, one perceived character.
 *
 * @remarks
 * Offsets are UTF-16 code units because that is what the DOM speaks, but a
 * user edits what looks like one character. Backspace used to step one code
 * point, so a family emoji came apart into its people on the way out and a
 * flag became half a flag — visible debris, and each fragment a valid
 * character the next press had to remove separately.
 */

const FAMILY = '👨‍👩‍👧'; // 8 code units, one character
const FLAG = '🇫🇷';
const ACCENT = 'é'; // e + combining acute: renders as é

test.describe('Backspace removes one character', () => {
  test('a family emoji goes in a single press', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type(`bonjour ${FAMILY}`);
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('bonjour ');
  });

  test('a flag goes in a single press', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type(`France ${FLAG}`);
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('France ');
  });

  test('a combining accent leaves with its letter', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type(`caf${ACCENT}`);
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('caf');
  });

  test('plain letters still go one at a time', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('abc');
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('ab');
  });

  test('several emoji come off one by one, not all at once', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type(`${FAMILY}${FLAG}`);
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe(FAMILY);
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('');
  });
});

test.describe('Delete removes one character forward', () => {
  test('a family emoji goes in a single press', async ({ editor }) => {
    await editor.setDocument([`${FAMILY}fin`]);
    await editor.caret(0, 0);
    await editor.press('Delete');
    expect((await editor.texts())[0]).toBe('fin');
  });
});

test.describe('a range never keeps half a character', () => {
  test('formatting a range that starts mid-emoji covers the whole emoji', async ({ page, editor }) => {
    await editor.setDocument([`a${FAMILY}b`]);
    // 2 lands inside the family's first surrogate pair
    await editor.selectRange([0, 2], [0, 1 + FAMILY.length]);
    await editor.press('Meta+b');
    const html = await page.locator('.nbe-editor .nbe-leaf').first().innerHTML();
    // the emoji is bold as a whole rather than split across two elements
    expect(html).not.toContain('�');
    expect((await editor.texts())[0]).toBe(`a${FAMILY}b`);
    expect(editor.errors()).toEqual([]);
  });

  test('typing over such a range replaces whole characters', async ({ editor }) => {
    await editor.setDocument([`a${FAMILY}b`]);
    await editor.selectRange([0, 2], [0, 1 + FAMILY.length]);
    await editor.type('X');
    // never "a<half an emoji>Xb"
    expect((await editor.texts())[0]).toBe('aXb');
  });
});
