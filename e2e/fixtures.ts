import { test as base, expect, type Page } from '@playwright/test';

/**
 * A debugging harness first, a test suite second.
 *
 * Every helper here answers a question you would otherwise ask by hand in
 * DevTools: what does the model hold, where is the caret really, what did the
 * document look like before and after. Naming them once means a failing test
 * reports the answer instead of a stack trace.
 */

export interface Editor {
  /** Block types in document order — the fastest shape check there is. */
  types(): Promise<string[]>;
  /** Plain text per block. */
  texts(): Promise<string[]>;
  /** Put the caret in the block at `index`, at `offset` characters in. */
  caret(index: number, offset: number): Promise<void>;
  /** Where the caret is now, as (block index, offset). */
  caretAt(): Promise<{ index: number; offset: number } | null>;
  /** Type text through real keyboard events. */
  type(text: string): Promise<void>;
  press(keys: string): Promise<void>;
  /** Select from one block/offset to another, across blocks if needed. */
  selectRange(from: [number, number], to: [number, number]): Promise<void>;
  /** What the browser reports as selected — the truth the model must match. */
  selectionText(): Promise<string>;
  /** Start from the demo's seeded document. */
  reset(): Promise<void>;
  /**
   * Start from a document you control.
   *
   * @remarks
   * Seeded through the demo's own persistence rather than by mutating the
   * editor, so the load path — including migrations — is exercised too. A
   * harness that installs state behind the product's back stops testing it.
   */
  setDocument(paragraphs: string[]): Promise<void>;
  /** Console errors seen so far. Empty is part of every assertion. */
  errors(): string[];
}

function makeEditor(page: Page, errors: string[]): Editor {
  const leaves = () => page.locator('.nbe-editor > .nbe-block .nbe-leaf');

  /**
   * `selectionchange` is asynchronous, so a DOM range set in one task is not
   * yet the model's selection in that same task. Anything acting on the model
   * — paste, a command, a key handler — would see the previous selection.
   * Every helper that moves the caret therefore waits a frame; forgetting this
   * is what made the first run of this harness report seven false failures.
   */
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  const setCaret = async (index: number, offset: number) => {
    await page.evaluate(
      ({ i, o }) => {
        const leaf = document.querySelectorAll<HTMLElement>('.nbe-editor .nbe-leaf')[i];
        if (!leaf) throw new Error(`no leaf at index ${i}`);
        // focus the editable HOST, which is the leaf under the per-block
        // topology and the root under single-host. Focusing the leaf blindly
        // is a no-op there, and every edit then lands nowhere.
        (leaf.closest<HTMLElement>('[contenteditable]') ?? leaf).focus();
        const range = document.createRange();
        const node = leaf.firstChild ?? leaf;
        range.setStart(node, Math.min(o, node.textContent?.length ?? 0));
        range.collapse(true);
        const sel = document.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      },
      { i: index, o: offset },
    );
    await settle();
  };

  return {
    types: () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.nbe-editor > .nbe-block')].map(
          (b) => [...b.classList].find((c) => c.startsWith('nbe-t-'))?.slice(6) ?? '?',
        ),
      ),
    texts: () => leaves().allTextContents(),
    caret: setCaret,
    caretAt: () =>
      page.evaluate(() => {
        const sel = document.getSelection();
        if (!sel?.anchorNode) return null;
        const node = sel.anchorNode;
        const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
        const leaf = el?.closest('.nbe-leaf');
        if (!leaf) return null;
        const all = [...document.querySelectorAll('.nbe-editor .nbe-leaf')];
        return { index: all.indexOf(leaf), offset: sel.anchorOffset };
      }),
    type: (text) => page.keyboard.type(text),
    press: (keys) => page.keyboard.press(keys),
    selectRange: async ([fi, fo], [ti, to]) => {
      await page.evaluate(
        ({ fi, fo, ti, to }) => {
          const all = document.querySelectorAll<HTMLElement>('.nbe-editor .nbe-leaf');
          const a = all[fi]!;
          const b = all[ti]!;
          const sel = document.getSelection()!;
          sel.setBaseAndExtent(a.firstChild ?? a, fo, b.firstChild ?? b, to);
        },
        { fi, fo, ti, to },
      );
      await settle();
    },
    selectionText: () => page.evaluate(() => document.getSelection()?.toString() ?? ''),
    reset: async () => {
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
    },
    setDocument: async (paragraphs) => {
      /*
       * Written by an init script rather than by evaluate-then-reload, because
       * the demo flushes its workspace to localStorage on `pagehide` — a
       * reload therefore writes the *old* document back over the seed. This
       * cost the harness three false failures before it was found, and it is
       * exactly the kind of product behaviour a harness has to respect rather
       * than work around.
       */
      const doc = {
        id: 'seed-page',
        type: 'page',
        version: 1,
        props: { title: 'Test' },
        children: paragraphs.map((t, i) => ({
          id: `seed-${i}`,
          type: 'paragraph',
          version: 1,
          ...(t ? { text: [{ text: t }] } : {}),
        })),
      };
      await page.addInitScript(
        ([key, value]) => {
          // init scripts run in *every* frame, and a sandboxed one has no
          // storage to write to — a page dropped into the editor would
          // otherwise fill `errors()` with SecurityErrors that are the
          // harness's, not the product's
          try {
            localStorage.setItem(key as string, value as string);
          } catch {
            /* no storage in this frame */
          }
        },
        ['nbe-workspace-v1', JSON.stringify({ pages: [doc], openId: doc.id })] as const,
      );
      await page.reload();
      await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
    },
    errors: () => errors,
  };
}

/**
 * The topology under test, from `TOPOLOGY` in the environment.
 *
 * @remarks
 * D3 turned out to depend on it, so every interaction spec should be runnable
 * against both. `TOPOLOGY=single-host pnpm e2e` is the whole switch.
 */
export const TOPOLOGY = process.env.TOPOLOGY === 'single-host' ? 'single-host' : 'per-block';

export const test = base.extend<{ editor: Editor }>({
  editor: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(TOPOLOGY === 'single-host' ? '/?topology=single-host' : '/');
    await page.locator('.nbe-editor .nbe-leaf').first().waitFor();
    await use(makeEditor(page, errors));
  },
});

export { expect };
