import { test, expect } from './fixtures';

/**
 * Freezing the chrome so it can be looked at.
 *
 * Everything floating here is bound to the pointer being somewhere: the gutter
 * follows the hovered block, a menu closes on the first press outside it. All
 * of it right, and all of it making the chrome impossible to inspect — moving
 * the mouse toward the devtools is the gesture that dismisses the thing you
 * were going to inspect.
 */
test.describe('the debug hold', () => {
  test('pins an open menu against a press outside, and Escape always lets go', async ({
    page,
    editor,
  }) => {
    await editor.setDocument(['un', 'deux']);
    await page.goto('/?debug=on');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();

    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    await expect(page.locator('.nbe-menu')).toBeVisible();

    await page.keyboard.press('Alt+Shift+D');
    await expect(page.locator('.nbe-debug-badge')).toBeVisible();

    // the press that would normally dismiss it
    await page.mouse.click(5, 5);
    await expect(page.locator('.nbe-menu')).toBeVisible();

    // …and the way out is always there
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-debug-badge')).toHaveCount(0);
    await page.mouse.click(5, 5);
    await expect(page.locator('.nbe-menu')).toHaveCount(0);
    expect(editor.errors()).toEqual([]);
  });

  test('is not there unless it was asked for', async ({ page, editor }) => {
    await editor.setDocument(['un']);
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.press('Alt+Shift+D');
    await expect(page.locator('.nbe-debug-badge')).toHaveCount(0);
  });
});
