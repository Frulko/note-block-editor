import { test, expect } from './fixtures';

/**
 * How fast it actually is.
 *
 * @remarks
 * The competitive survey (`docs/research/competitive-landscape.md`) found that
 * latency is a viable wedge on its own — Nuclino has fewer features than
 * anyone and wins users purely on speed, while Notion's slowness is its most
 * durable complaint across seven years. It also set the bars: **keystroke to
 * paint under 16ms** so nothing drops a frame, and a document that stays
 * usable at a scale where the competition degrades (Notion at ~2000 pages,
 * Anytype at 8000 objects).
 *
 * None of it had ever been measured here. This measures it.
 *
 * **Medians, not means, over many samples**, and thresholds well above the
 * target. A performance test that fails on a noisy CI runner teaches people to
 * ignore it; the job is to catch a regression of *kind* — an O(n²) walk, a
 * full re-render per keystroke — not to police a millisecond.
 */

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Type `count` characters, returning the per-keystroke latency in ms. */
async function keystrokeLatencies(page: import('@playwright/test').Page, count: number): Promise<number[]> {
  return page.evaluate(async (n) => {
    const leaf = document.querySelector('.nbe-leaf') as HTMLElement;
    leaf.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(leaf);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      // the real input path: `beforeinput` is what the editor intercepts
      leaf.dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true }),
      );
      // wait for the frame that paints it, which is what a person perceives
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      out.push(performance.now() - start);
    }
    return out;
  }, count);
}

test.describe('speed, which the survey says is a wedge on its own', () => {
  test('a keystroke lands within a frame on a small document', async ({ page, editor }) => {
    await editor.setDocument(['bonjour']);
    const latencies = await keystrokeLatencies(page, 40);
    const p50 = median(latencies);
    console.log(`frappe, petit document : médiane ${p50.toFixed(1)}ms`);
    // the target is 16ms; the gate is generous enough to survive a shared runner
    expect(p50).toBeLessThan(50);
  });

  test('and still does with five hundred blocks on the page', async ({ page, editor }) => {
    await editor.setDocument(Array.from({ length: 500 }, (_, i) => `ligne ${i}`));
    const latencies = await keystrokeLatencies(page, 40);
    const p50 = median(latencies);
    console.log(`frappe, 500 blocs : médiane ${p50.toFixed(1)}ms`);
    /*
     * The property under test is that typing cost does not scale with document
     * size. Notion's own engineer names this as why they lose to Google Docs —
     * their rendered DOM is also their input surface, so a keystroke touches
     * the whole document. If this ever fails, look for a full re-render.
     */
    expect(p50).toBeLessThan(50);
  });

  test('five hundred blocks render in well under a second', async ({ page, editor }) => {
    const start = Date.now();
    await editor.setDocument(Array.from({ length: 500 }, (_, i) => `ligne ${i}`));
    await page.locator('.nbe-leaf').nth(499).waitFor();
    const elapsed = Date.now() - start;
    console.log(`rendu de 500 blocs : ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5000);
  });
});

/**
 * What a *long* document costs, which is the question behind "should this be
 * virtualized".
 *
 * The answer was measured before anything was built, and it is the reason
 * there is no virtualizer here. At 500 / 2000 / 5000 blocks:
 *
 * | | 500 | 2000 | 5000 |
 * | --- | --- | --- | --- |
 * | keystroke | 8.3ms | 8.3ms | 8.4ms |
 * | scrolled frame | 7.7ms | 7.8ms | 7.6ms |
 * | whole document on screen | 191ms | 404ms | 1010ms |
 *
 * Typing and scrolling are **flat** — a keystroke already repaints one block,
 * and the browser is perfectly happy scrolling fifteen thousand nodes. The one
 * thing that scaled was the opening render, and taking every off-screen block
 * out of the DOM to fix it would have put the caret, find, the comment markers
 * and every `blockEl` call somewhere they do not expect. `content-visibility:
 * auto` was tried as the native answer and measured **ten times worse**.
 *
 * So the opening render streams instead, and these are the three properties
 * that keep that decision honest.
 */
test.describe('a long document', () => {
  const LONG = Array.from({ length: 4000 }, (_, i) => `ligne ${i} avec un peu de texte`);

  /**
   * One page load, three assertions.
   *
   * Deliberately not three tests: a four-thousand-block mount is expensive
   * enough that three of them running beside the rest of the suite starve the
   * runner, and a suite that fails somewhere else because of a performance
   * test is a suite people stop trusting. Measured that happening, twice, on
   * two different specs.
   */
  test('paints at once, arrives in full, and costs the same to use', async ({ page, editor }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __firstPaint?: number };
      const tick = () => {
        if (document.querySelector('.nbe-editor > .nbe-block')) w.__firstPaint ??= performance.now();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await editor.setDocument(LONG);
    await page.locator('.nbe-leaf').first().waitFor();

    // 1. the opening render streams, so first paint does not scale: measured
    // at 106ms here against 86ms for five hundred blocks
    const first = await page.evaluate(() => (window as unknown as { __firstPaint: number }).__firstPaint);
    console.log(`première peinture, ${LONG.length} blocs : ${first.toFixed(0)}ms`);
    expect(first).toBeLessThan(700);

    // 2. and all of it arrives. A streamed document that stops halfway is a
    // document with content missing, which is worse than a slow one
    await page.locator('.nbe-leaf').nth(LONG.length - 1).waitFor();
    expect(await page.locator('.nbe-editor > .nbe-block').count()).toBe(LONG.length);
    expect((await editor.texts())[LONG.length - 1]).toBe(`ligne ${LONG.length - 1} avec un peu de texte`);

    // 3. typing and scrolling stay flat, which is the measurement that says no
    // virtualizer is needed here
    const p50 = median(await keystrokeLatencies(page, 30));
    const frame = await page.evaluate(async () => {
      const scroller = document.querySelector('.page-scroll')!;
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        scroller.scrollTop += 600;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return (performance.now() - start) / 20;
    });
    console.log(`${LONG.length} blocs : frappe ${p50.toFixed(1)}ms, défilement ${frame.toFixed(1)}ms/frame`);
    expect(p50).toBeLessThan(50);
    expect(frame).toBeLessThan(50);
  });
});
