import { test, expect } from './fixtures';

/** The classes on the runs of the first block, in order. */
const marks = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.nbe-editor > .nbe-block:first-child .nbe-leaf span')].map((s) => [
      s.className,
      s.textContent,
    ]),
  );

test.describe('the shifted marks', () => {
  test('Cmd/Ctrl+. makes a superscript and toggles it back off', async ({ page, editor }) => {
    await editor.setDocument(['x2 + 1']);
    await editor.selectRange([0, 1], [0, 2]);
    await editor.press('ControlOrMeta+.');

    expect(await marks(page)).toEqual([['nbe-m-superscript', '2']]);
    expect(await editor.texts()).toEqual(['x2 + 1']); // a mark, not an edit

    // no re-selecting: the command leaves the range it acted on, so a second
    // press is the toggle a person would expect
    await editor.press('ControlOrMeta+.');
    expect(await marks(page)).toEqual([]);
    expect(editor.errors()).toEqual([]);
  });

  test('Cmd/Ctrl+, makes a subscript', async ({ page, editor }) => {
    await editor.setDocument(['H2O']);
    await editor.selectRange([0, 1], [0, 2]);
    await editor.press('ControlOrMeta+,');

    expect(await marks(page)).toEqual([['nbe-m-subscript', '2']]);
  });

  test('the format toolbar offers both, and applies them', async ({ page, editor }) => {
    await editor.setDocument(['x2']);
    await editor.selectRange([0, 1], [0, 2]);
    await page.locator('.nbe-seltoolbar').waitFor();

    await page.locator('.nbe-fmt-superscript').click();
    expect(await marks(page)).toEqual([['nbe-m-superscript', '2']]);
    await expect(page.locator('.nbe-fmt-subscript')).toBeVisible();
  });
});

/**
 * `⌘K` is the one formatting shortcut with a dialog behind it, and it used to
 * demand a selection. The way you actually reach it is with the caret sitting
 * *in* a link you just read the URL of — nothing selected, nothing to select
 * by hand without losing your place.
 */
test.describe('Cmd/Ctrl+K and the link form', () => {
  const field = (page: import('@playwright/test').Page) => page.locator('.nbe-seltoolbar-linkform input');

  test('a selection opens the form, and Enter applies the href', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await editor.press('ControlOrMeta+k');

    await field(page).fill('https://example.com');
    await field(page).press('Enter');

    await expect(page.locator('.nbe-editor a.nbe-m-link')).toHaveAttribute('href', 'https://example.com');
    expect(editor.errors()).toEqual([]);
  });

  test('a caret inside the link is enough — it selects it for you', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.selectRange([0, 0], [0, 7]);
    await editor.press('ControlOrMeta+k');
    await field(page).fill('https://example.com');
    await field(page).press('Enter');

    await editor.caret(0, 3); // in the middle of the link, nothing selected
    await editor.press('ControlOrMeta+k');

    await expect(field(page)).toHaveValue('https://example.com');
    expect(await editor.selectionText()).toBe('bonjour');
  });

  test('with no selection and no link under the caret it does nothing', async ({ page, editor }) => {
    await editor.setDocument(['bonjour monde']);
    await editor.caret(0, 3);
    await editor.press('ControlOrMeta+k');

    await expect(page.locator('.nbe-seltoolbar-linkform')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });
});

/**
 * Inline code has a middle, and it was not being treated as one.
 *
 * `expand: 'none'` is a rule about the *boundary* of a span — text typed after
 * inline code is not code. It was applied everywhere, interior included, so
 * putting the caret inside `` `const` `` and typing produced a code span, a
 * plain character, and another code span. Reported 2026-08-10.
 */
test.describe('typing inside an inline code span', () => {
  /** `abc` as inline code, written by the autoformat rule that makes it. */
  async function codeSpan(editor: import('./fixtures').Editor) {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('`abc` fin');
  }

  test('a character typed in the middle joins the code', async ({ page, editor }) => {
    await codeSpan(editor);
    await editor.caret(0, 2); // between b and c
    await editor.type('X');

    expect(await editor.texts()).toEqual(['abXc fin']);
    // only the marked runs are spans; the plain tail is a bare text node
    expect(await marks(page)).toEqual([['nbe-m-code', 'abXc']]);
    expect(editor.errors()).toEqual([]);
  });

  test('the end of the span is still the way out', async ({ page, editor }) => {
    await codeSpan(editor);
    await editor.caret(0, 3); // just past the c
    await editor.type('Z');

    expect(await editor.texts()).toEqual(['abcZ fin']);
    expect(await marks(page)).toEqual([['nbe-m-code', 'abc']]);
  });

  test('Escape from the middle puts the caret past the span', async ({ page, editor }) => {
    await codeSpan(editor);
    await editor.caret(0, 1);
    await page.keyboard.press('Escape');
    await editor.type('Z');

    // out of the code, not out of the text: a second Escape is what leaves
    expect(await editor.texts()).toEqual(['abcZ fin']);
    expect(await marks(page)).toEqual([['nbe-m-code', 'abc']]);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape outside one still escalates to a block selection', async ({ page, editor }) => {
    await editor.setDocument(['bonjour']);
    await editor.caret(0, 3);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-block.nbe-selected')).toHaveCount(1);
  });
});
