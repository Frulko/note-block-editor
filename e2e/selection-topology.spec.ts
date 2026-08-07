import { test, expect, TOPOLOGY } from './fixtures';

/**
 * What a `Selection` can span, measured rather than assumed.
 *
 * D3 originally claimed the browser would hold one across several
 * `contenteditable` hosts. Measured in Chromium 150 (headed) and 151
 * (headless): **it will not.** A selection is clamped to the editing host it
 * starts in, whether built with `setBaseAndExtent` or `addRange`, whether the
 * host is `plaintext-only` or `true`, and whether or not it has focus first.
 *
 * That measurement is what `cross-block-highlight.ts` exists for, so these
 * tests stay as its justification: this file describes the *browser*, and
 * `cross-block-selection.spec.ts` describes what a user gets. If a future
 * Chromium restores spanning, the first test starts failing — the signal to
 * delete the highlight layer rather than to revisit D3 again.
 */

test.describe('what a selection can actually span', () => {
  test.skip(TOPOLOGY !== 'per-block', 'describes the per-block topology');

  test('per-block hosts clamp a programmatic range to the first block', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second']);
    await editor.selectRange([0, 2], [1, 3]);
    const selected = await editor.selectionText();
    // the honest assertion: only the first block's tail is selected
    expect(selected).toBe('emier');
    expect(selected).not.toContain('sec');
  });

  test('the same range spans freely when the hosts are not editable', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second']);
    const spanned = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll<HTMLElement>('.nbe-editor .nbe-leaf')];
      leaves.forEach((l) => l.removeAttribute('contenteditable'));
      const sel = document.getSelection()!;
      sel.setBaseAndExtent(leaves[0]!.firstChild!, 2, leaves[1]!.firstChild!, 3);
      return sel.toString();
    });
    // so the constraint is the editing host boundary, not the DOM structure
    expect(spanned).toContain('emier');
    expect(spanned).toContain('sec');
  });

  test('a single editable root spans too — which is what singleHostTopology gives', async ({ page, editor }) => {
    await editor.setDocument(['premier', 'second']);
    const spanned = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.nbe-editor')!;
      const leaves = [...document.querySelectorAll<HTMLElement>('.nbe-editor .nbe-leaf')];
      leaves.forEach((l) => l.removeAttribute('contenteditable'));
      root.setAttribute('contenteditable', 'plaintext-only');
      const sel = document.getSelection()!;
      sel.setBaseAndExtent(leaves[0]!.firstChild!, 2, leaves[1]!.firstChild!, 3);
      return sel.toString();
    });
    expect(spanned).toContain('emier');
    expect(spanned).toContain('sec');
  });
});
