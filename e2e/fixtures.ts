import { test as base, expect, type Page } from '@playwright/test';
import { EMPTY_LINE } from '../packages/dom/src/topology';

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
        /*
         * Walked, not `leaf.firstChild`: a block carrying a mark holds spans,
         * and a link holds an `<a>`. `setStart(element, 3)` then means "child
         * node 3" and throws — so a caret could not be put inside formatted
         * text at all, which is exactly where the interesting bugs are.
         */
        const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
        let node: Node = leaf;
        let left = o;
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          node = t;
          const len = t.textContent?.length ?? 0;
          if (left <= len) break;
          left -= len;
        }
        range.setStart(node, Math.min(left, node.textContent?.length ?? 0));
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
    // the empty-line sentinels are DOM, not text: the model never holds one,
    // so a spec asserting on the text must not see them either
    texts: async () => (await leaves().allTextContents()).map((t) => t.split(EMPTY_LINE).join('')),
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
        // counted from the leaf, not read off the node: a caret on an empty
        // line sits in a sentinel, whose own offset says nothing about the model
        const range = document.createRange();
        range.selectNodeContents(leaf);
        range.setEnd(node, sel.anchorOffset);
        return { index: all.indexOf(leaf), offset: range.toString().split('\u200b').join('').length };
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

/**
 * Drag a selection from one block into another, the way a mouse does.
 *
 * @remarks
 * The only way to express a cross-block range under the per-block topology:
 * `selectRange` builds it with `setBaseAndExtent`, which every engine clamps
 * to the editing host it starts in (selection-topology.spec.ts measures it).
 * WebKit clamps to the block's *end*, Chromium to the offset asked for — so a
 * spec that reaches for `selectRange` across blocks asserts on the engine's
 * clamping rather than on the editor, and disagrees per engine.
 */
export async function dragSelect(page: Page, from: number, to: number) {
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
