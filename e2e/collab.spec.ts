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

/**
 * Talking about the document, and going where someone else is.
 *
 * @remarks
 * The pane used to open a `prompt()` for a comment, which could take a first
 * message and nothing after it — so a *discussion*, which is the only reason
 * two people need comments rather than notes, was the one thing this demo could
 * not show. And every message it did take was anonymous on the screen that did
 * not write it.
 *
 * Following is the other half of "there is somebody else here": a caret tells
 * you where they are only while you are both looking at the same part of the
 * document.
 */
test.describe('two people talking', () => {
  test('a comment and its reply carry the right name in both panes', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto(COLLAB);
    const alice = page.locator('.pane').nth(0);
    const basile = page.locator('.pane').nth(1);
    await expect(basile.getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });

    await alice.locator('.nbe-editor > .nbe-block').first().hover();
    await alice.locator('.nbe-controls-right .nbe-comment').click();
    await page.locator('.nbe-comments .nbe-comment-field').waitFor();
    await page.keyboard.type('une question d’Alice');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    // Basile answers from his own pane, so the author is his
    await basile.locator('.threads .panel-btn', { hasText: 'Répondre' }).first().click();
    await page.locator('.nbe-comments .nbe-comment-field').waitFor();
    await page.keyboard.type('la réponse de Basile');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    for (const pane of [alice, basile]) {
      await expect(pane.locator('.threads .message b')).toHaveText(['Alice', 'Basile']);
    }
    // and the margin counts the messages, which is what a reader counts
    await expect(alice.locator('.nbe-comment-count').first()).toHaveText('2');
    expect(dialogs).toEqual([]); // no prompt(), in either direction
  });

  test('following a peer takes the pane where they are, and lets go', async ({ page }) => {
    await page.goto(COLLAB);
    const alice = page.locator('.pane').nth(0);
    const basile = page.locator('.pane').nth(1);
    await expect(basile.getByText('Réunion de lancement')).toBeVisible({ timeout: 10_000 });

    // a document long enough for "off screen" to mean something
    await basile.locator('.nbe-editor > .nbe-block').last().click();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.type('ligne');
      await page.keyboard.press('Enter');
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    await alice.locator('.person-chip').click();
    await alice.locator('.person-menu .panel-btn', { hasText: 'Suivre le curseur' }).click();
    await expect(alice.locator('.person-chip.is-followed')).toHaveCount(1);
    // the viewport actually moved, which is the whole of what following is
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);

    /*
     * Reading somewhere else *is* saying you have stopped following, so a press
     * in the text ends it — there is no third state where the page keeps moving
     * under someone who has taken the wheel back.
     */
    await alice.locator('.nbe-editor .nbe-leaf').first().click();
    await expect(alice.locator('.person-chip.is-followed')).toHaveCount(0);
  });
});
