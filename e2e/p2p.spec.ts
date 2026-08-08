import { expect, test, type Page } from '@playwright/test';

/**
 * Two browsers, one document, and no relay in the path.
 *
 * @remarks
 * `docs/research/p2p-any-sync.md` argues that "fully peer-to-peer" is a ladder
 * rather than a state, and that the rung worth reaching is: signal through a
 * relay, then stop using it. Every other test in this suite would pass on a
 * design that never left the relay, so this is the only file that holds the
 * claim up.
 *
 * **The sockets are closed mid-test on purpose.** Asserting convergence while
 * the relay is still reachable proves nothing — the bytes would arrive over it.
 * So this waits for the data channel, closes every WebSocket the page owns, and
 * *then* types. If the edit still crosses, it crossed directly, because there is
 * nothing else left.
 *
 * Chromium only: two peers here are two tabs, and WebKit's WebRTC needs a
 * capture permission prompt this cannot answer headlessly. The state machine is
 * covered by `packages/cli/test/p2p.test.ts` against real libdatachannel and by
 * `native/swift`'s `P2PTests`, so the engine coverage this misses is the ICE
 * agent's, not ours.
 */

const RELAY = 'ws://localhost:8788';
const DEMO = 'http://localhost:5175/';

/**
 * Record every WebSocket the page opens, so the test can take them away.
 *
 * Installed before any script runs. There is no other handle on them: the
 * transport owns its socket and deliberately exposes no way to break it, which
 * is right for the product and inconvenient exactly once, here.
 */
async function trackSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
    const Original = window.WebSocket;
    class Tracked extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    window.WebSocket = Tracked as unknown as typeof WebSocket;
  });
}

const join = (room: string, name: string): string =>
  `${DEMO}?room=${room}&relay=${encodeURIComponent(RELAY)}&name=${name}`;

/** The demo's status line, which is computed from real channel states. */
const status = (page: Page) => page.locator('.bar p');

test.describe('peer-to-peer over WebRTC', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'two tabs and an ICE agent');

  test('two peers reach a data channel and the relay stops carrying the document', async ({ browser }) => {
    const room = `p2p-${Date.now()}`;
    const context = await browser.newContext();
    const alice = await context.newPage();
    const basile = await context.newPage();
    await trackSockets(alice);
    await trackSockets(basile);

    await alice.goto(join(room, 'Alice'));
    await basile.goto(join(room, 'Basile'));

    // "en direct" appears only when every known peer has an open channel
    await expect(status(alice)).toContainText('en direct', { timeout: 20_000 });
    await expect(status(basile)).toContainText('en direct', { timeout: 20_000 });
    await expect(status(alice)).toContainText('le relais ne voit plus rien');

    // take the relay away from both pages
    const drop = (page: Page) =>
      page.evaluate(() => {
        for (const socket of (window as unknown as { __sockets: WebSocket[] }).__sockets) socket.close();
      });
    await drop(alice);
    await drop(basile);

    const editor = alice.locator('.nbe-editor');
    await editor.locator('.nbe-leaf').first().click();
    await alice.keyboard.type('sans serveur');

    await expect(basile.locator('.nbe-editor').getByText('sans serveur')).toBeVisible({ timeout: 20_000 });

    // and back, because a channel that only worked one way would pass the above
    await basile.locator('.nbe-editor').getByText('sans serveur').click();
    await basile.keyboard.press('End');
    await basile.keyboard.type(' — et dans l’autre sens');
    await expect(editor.getByText('sans serveur — et dans l’autre sens')).toBeVisible({ timeout: 20_000 });

    await context.close();
  });

  test('a room of one stays on the relay, and says so', async ({ browser }) => {
    const context = await browser.newContext();
    const alone = await context.newPage();
    await alone.goto(join(`seul-${Date.now()}`, 'Seule'));

    // no peer to be direct with: the honest state is "waiting", not "p2p"
    await expect(status(alone)).toContainText('Ouvrez la même adresse ailleurs', { timeout: 20_000 });
    await expect(status(alone)).not.toContainText('en direct');

    await context.close();
  });
});
