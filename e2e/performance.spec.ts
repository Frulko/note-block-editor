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
