import { test, expect } from './fixtures';

/**
 * Offline-first, demonstrated rather than claimed.
 *
 * @remarks
 * The survey names partial offline as an anti-pattern that "invites trust it
 * cannot repay" — Notion's 2025 offline mode requires pre-downloading pages and
 * caches the first fifty rows of the first view of a database, and users said
 * so plainly. This project's claim is stronger: the editor is local, and the
 * network is something it can do without entirely.
 *
 * That had never been tested. These tests cut the network at the browser and
 * then use the editor.
 */

test.describe('the editor does not need the network', () => {
  test('every request it makes is to its own origin', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://localhost') && !url.startsWith('data:') && !url.startsWith('blob:')) {
        foreign.push(url);
      }
    });

    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    await page.waitForTimeout(500);

    /*
     * A remote font, an analytics beacon or a CDN script would each break the
     * promise quietly — the editor would work in development and phone home in
     * production. The charter names this for fonts specifically: Inter is
     * declared and never fetched.
     */
    expect(foreign).toEqual([]);
  });

  test('it keeps working with the network cut', async ({ page, context, editor }) => {
    // seeded first: the fixture reloads to install a document, and a reload is
    // the one thing a severed network genuinely prevents
    await editor.setDocument(['hors ligne']);

    // nothing may leave the machine from here on
    await context.route('**/*', (route) => route.abort());

    await page.locator('.nbe-leaf').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' et toujours vivant');

    expect((await editor.texts())[0]).toBe('hors ligne et toujours vivant');
    expect(editor.errors()).toEqual([]);
  });

  /*
   * "An edit survives a reload" is deliberately *not* repeated here — it is
   * `persistence.spec.ts`'s job, and writing it again through this file's
   * fixture would fight the harness rather than test the product: the fixture
   * seeds its document from an init script on every load, so anything typed
   * before a reload is overwritten by design.
   */

  test('but a cold start still needs the server — there is no service worker', async ({ page, context }) => {
    /*
     * The honest limit of the claim. The editor needs no network *once loaded*,
     * and asks nothing of anyone else's origin ever — but the page itself is
     * still fetched, so opening the app with no connection at all does not work
     * in the browser build. A service worker would close that, and there is
     * none.
     *
     * This is asserted rather than left implicit because "offline-first" with
     * an unstated cold-start hole is exactly the partial-offline pattern the
     * survey names as trust-destroying. The desktop and Obsidian builds do not
     * have this limit: their assets are local files.
     */
    await page.goto('/');
    await page.waitForSelector('.nbe-editor .nbe-leaf');
    const workers = await page.evaluate(async () =>
      'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : -1,
    );
    expect(workers, 'if a service worker is ever added, delete this test').toBe(0);

    await context.route('**/*', (route) => route.abort());
    await expect(page.reload()).rejects.toThrow();
  });
});
