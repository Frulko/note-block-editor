import { expect, test } from '@playwright/test';

/**
 * Two peers in one page.
 *
 * @remarks
 * The demo's claim is that the panes are real peers rather than one editor
 * rendered twice — two stores, a transport, an actual merge. A test that only
 * checked "text appears in both" would pass for the fake version too, so this
 * also checks the direction that a shared object could not fake: an edit made
 * in the *second* pane reaching the first, and a document that pane B never
 * had arriving over the handshake.
 */

/* `?demo=loopback` because the bare URL now joins a real room off the relay the
   dev server starts — the two-pane pair this file asserts on is the other mode. */
const COLLAB = 'http://localhost:5175/?demo=loopback';

test.describe('two peers, one document', () => {
  test('the joining peer receives a document it never had', async ({ page }) => {
    await page.goto(COLLAB);
    const panes = page.locator('.pane');
    await expect(panes).toHaveCount(2);
    // Basile starts empty; the seeded text can only be there via sync
    await expect(panes.nth(1).getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });
  });

  test('typing in one pane reaches the other', async ({ page }) => {
    await page.goto(COLLAB);
    const first = page.locator('.pane').nth(0).locator('.nbe-editor');
    const second = page.locator('.pane').nth(1).locator('.nbe-editor');
    await expect(second.getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });

    await first.getByText('Réunion de lancement').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (jeudi)');

    await expect(second.getByText('Réunion de lancement (jeudi)')).toBeVisible({ timeout: 10_000 });
  });

  test('and back the other way, which a shared object could not fake', async ({ page }) => {
    await page.goto(COLLAB);
    const first = page.locator('.pane').nth(0).locator('.nbe-editor');
    const second = page.locator('.pane').nth(1).locator('.nbe-editor');
    await expect(second.getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });

    await second.getByText('Réunion de lancement').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' — vendredi');

    await expect(first.getByText('Réunion de lancement — vendredi')).toBeVisible({ timeout: 10_000 });
  });

  test('a peer’s caret is painted in the other pane', async ({ page }) => {
    await page.goto(COLLAB);
    const first = page.locator('.pane').nth(0).locator('.nbe-editor');
    await expect(page.locator('.pane').nth(1).getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });

    await first.getByText('Réunion de lancement').click();
    await page.keyboard.press('End');

    // presence rides the same transport and never touches the document
    await expect(page.locator('.nbe-peer-caret').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.nbe-peer-name').first()).toHaveText(/Alice|Basile/);
  });
});
