import { test, expect, TOPOLOGY } from './fixtures';

/**
 * Cross-block selection must work. This is the spec that says what "work"
 * means, and it runs against both topologies.
 *
 * The browser will not hold a Selection across editing hosts, so under the
 * per-block topology the model carries the range and the Highlight API paints
 * it. What a user can observe — the selection is visible, and every command
 * acts on all of it — is asserted here rather than the mechanism.
 */

/** Drag from one block into another, the way a mouse does. */
async function dragSelect(page: import('@playwright/test').Page, from: number, to: number) {
  const box = async (i: number) => {
    const b = await page.locator('.nbe-editor .nbe-leaf').nth(i).boundingBox();
    if (!b) throw new Error(`no box for leaf ${i}`);
    return b;
  };
  const a = await box(from);
  const b = await box(to);
  await page.mouse.move(a.x + 8, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width - 8, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('a drag across blocks selects across blocks', () => {
  test('the model holds the whole range', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc', 'troisieme']);
    await dragSelect(page, 0, 1);
    const sel = await page.evaluate(() => {
      const el = document.querySelector('.nbe-editor')!;
      return el.classList.contains('nbe-crossblock');
    });
    // under single-host the browser holds it natively, so no painting is needed
    if (TOPOLOGY === 'per-block') expect(sel).toBe(true);
    expect(editor.errors()).toEqual([]);
  });

  test('the selection is painted, not invisible', async ({ page, editor }) => {
    test.skip(TOPOLOGY !== 'per-block', 'the browser paints it natively under single-host');
    await editor.setDocument(['premier bloc', 'second bloc']);
    await dragSelect(page, 0, 1);
    const painted = await page.evaluate(() => {
      const h = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get('nbe-selection');
      return h ? h.size : 0;
    });
    expect(painted).toBeGreaterThan(0);
  });

  test('typing replaces everything that was selected', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc', 'garde']);
    await dragSelect(page, 0, 1);
    await page.keyboard.type('X');
    const texts = await editor.texts();
    // the tail of the first block and the head of the last are gone, the
    // remainder merged upward — §5.2's resolveTextRange contract
    expect(texts[0]!.startsWith('p')).toBe(true);
    expect(texts[0]).toContain('X');
    expect(texts).toContain('garde');
  });

  test('Backspace deletes the whole range', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc', 'garde']);
    await dragSelect(page, 0, 1);
    await page.keyboard.press('Backspace');
    const texts = await editor.texts();
    expect(texts).toContain('garde');
    expect(texts.join('|')).not.toContain('second bloc');
  });

  test('bold applies across every selected block', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc']);
    await dragSelect(page, 0, 1);
    await page.keyboard.press('Meta+b');
    const bolded = await page.locator('.nbe-editor .nbe-m-bold').count();
    expect(bolded).toBeGreaterThan(1);
  });

  test('copy takes the whole range, not just the first block', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc']);
    await dragSelect(page, 0, 1);
    const copied = await page.evaluate(async () => {
      let text = '';
      document.addEventListener('copy', (e) => { text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''; }, { once: true, capture: false });
      document.execCommand('copy');
      return text;
    });
    expect(copied).toContain('second');
  });

  test('shift-click extends across blocks too', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc', 'garde']);
    await editor.caret(0, 2);
    const b = (await page.locator('.nbe-editor .nbe-leaf').nth(1).boundingBox())!;
    await page.mouse.click(b.x + b.width - 6, b.y + b.height / 2, { modifiers: ['Shift'] });
    await page.keyboard.press('Backspace');
    expect((await editor.texts()).join('|')).not.toContain('second bloc');
  });

  test('a press elsewhere releases it — the guard is not a trap', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc', 'troisieme']);
    await dragSelect(page, 0, 1);
    await editor.caret(2, 3);
    await page.keyboard.type('!');
    const texts = await editor.texts();
    // the earlier selection is gone: nothing was replaced, one character landed
    expect(texts[0]).toBe('premier bloc');
    expect(texts[1]).toBe('second bloc');
    expect(texts[2]).toContain('!');
    expect(await page.evaluate(() => document.querySelector('.nbe-editor')!.classList.contains('nbe-crossblock'))).toBe(false);
  });

  test('a fast flick — one pointermove — selects just the same', async ({ page, editor }) => {
    test.skip(TOPOLOGY !== 'per-block', 'the browser owns the drag under single-host');
    await editor.setDocument(['premier bloc', 'second bloc', 'troisieme']);
    const a = (await page.locator('.nbe-editor .nbe-leaf').nth(0).boundingBox())!;
    const b = (await page.locator('.nbe-editor .nbe-leaf').nth(2).boundingBox())!;
    await page.mouse.move(a.x + 8, a.y + a.height / 2);
    await page.mouse.down();
    // ONE move, the whole way: the browser applies its own selection after our
    // handler runs, so anything that snapshots the DOM here reads it stale
    await page.mouse.move(b.x + b.width - 8, b.y + b.height / 2);
    await page.mouse.up();
    await page.keyboard.press('Backspace');
    expect((await editor.texts()).join('|')).not.toContain('second bloc');
  });

  test('a collapsed caret paints nothing', async ({ page, editor }) => {
    await editor.setDocument(['premier bloc', 'second bloc']);
    await editor.caret(0, 3);
    const painted = await page.evaluate(() =>
      document.querySelector('.nbe-editor')!.classList.contains('nbe-crossblock'),
    );
    expect(painted).toBe(false);
  });
});
