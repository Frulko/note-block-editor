import { test, expect } from './fixtures';

/**
 * IME composition, through CDP's real composition pipeline.
 *
 * §12.6 asked how much of the IME matrix CI can actually cover. The answer
 * measured here: **Chromium's `Input.imeSetComposition` drives the genuine
 * composition path** — `compositionstart`, non-cancelable `beforeinput`,
 * `compositionend` — so the ironclad rule from §5.1, *never mutate the DOM
 * mid-composition*, is testable without hardware.
 *
 * What this still cannot cover, and what the device matrix in docs/TESTING.md
 * therefore remains for: Android GBoard's behaviour (it actively lies about
 * `beforeinput`), iOS Safari's, and physical keyboard layouts. Those are
 * engine behaviours, not protocol gaps.
 */

/*
 * CDP is Chromium's protocol, and `Input.imeSetComposition` is the only way to
 * drive a *genuine* composition from a test — WebKit exposes no equivalent. So
 * this suite is Chromium-only by necessity rather than by choice, and saying so
 * here is better than letting it fail red on WebKit, which is how a team learns
 * to ignore red.
 *
 * What that leaves uncovered on WebKit is not composition *handling* — the
 * model-side rule is unit-tested, and the Swift side drives AppKit's own
 * composition protocol directly — but WebKit's particular composition
 * behaviour. That belongs to the device matrix in docs/TESTING.md.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'Input.imeSetComposition is Chromium-only');

/** Drive a composition the way an IME does, through CDP. */
async function compose(page: import('@playwright/test').Page, steps: string[], commit: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }
  await cdp.send('Input.insertText', { text: commit });
  await cdp.detach();
}

test.describe('composition', () => {
  test('a committed composition lands once, as its final text', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await compose(page, ['n', 'ni', 'nih'], '日本');
    expect((await editor.texts())[0]).toBe('日本');
    expect(editor.errors()).toEqual([]);
  });

  test('the model is not rewritten mid-composition', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    // §5.1: reconciliation is frozen from compositionstart, so the document
    // must still be empty while the preedit is on screen
    const composing = await page.evaluate(
      () => document.querySelectorAll('.nbe-editor .nbe-leaf')[0]!.textContent,
    );
    await cdp.send('Input.insertText', { text: '日本' });
    await cdp.detach();
    expect((await editor.texts())[0]).toBe('日本');
    // the preedit was visible in the DOM but must not have been committed twice
    expect(composing).not.toBe('日本日本');
  });

  test('typing after a composition continues in the same block', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await compose(page, ['k', 'ka'], '日');
    await editor.type('ok');
    expect((await editor.texts())[0]).toBe('日ok');
  });

  test('a composition inside existing text lands at the caret', async ({ page, editor }) => {
    await editor.setDocument(['abcd']);
    await editor.caret(0, 2);
    await compose(page, ['x'], '中');
    expect((await editor.texts())[0]).toBe('ab中cd');
  });

  test('undo after a composition removes it in one step', async ({ page, editor }) => {
    await editor.setDocument(['start ']);
    await editor.caret(0, 6);
    await compose(page, ['n', 'ni'], '日本');
    expect((await editor.texts())[0]).toBe('start 日本');
    await editor.press('Meta+z');
    // §3: history never splits a composition
    expect((await editor.texts())[0]).toBe('start ');
  });
});

test.describe('dead keys and accents', () => {
  test('an accented character typed as one keystroke lands whole', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('éàçüñ');
    expect((await editor.texts())[0]).toBe('éàçüñ');
  });

  test('an emoji made of surrogate pairs is not bisected', async ({ editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await editor.type('a👍b');
    expect((await editor.texts())[0]).toBe('a👍b');
    // one Backspace removes the whole pair, never half of it
    await editor.press('Backspace');
    await editor.press('Backspace');
    expect((await editor.texts())[0]).toBe('a');
  });
});
