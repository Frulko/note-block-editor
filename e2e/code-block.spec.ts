import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

/**
 * The code block, and specifically the claim its design rests on: **the
 * colours are painted, not marked up**. If a highlighter ever starts inserting
 * spans into the leaf, the caret, the IME and the DOM→model reconciler all
 * inherit a problem — so the invariant is asserted directly, in the browser,
 * rather than trusted.
 */

async function makeCode(page: Page, editor: { setDocument(p: string[]): Promise<void> }): Promise<void> {
  await editor.setDocument(['']);
  await page.locator('.nbe-leaf').first().click();
  await page.keyboard.type('```');
  await expect(page.locator('.nbe-t-code')).toBeVisible();
}

/** Painted ranges, by highlight name — the CSS Custom Highlight registry. */
const painted = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const [name, highlight] of (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights) {
      if (name.startsWith('nbe-code-')) out[name] = highlight.size;
    }
    return out;
  });

/**
 * How many registered ranges still point *into the code*.
 *
 * @remarks
 * The assertion that can tell a colour from a colour-shaped entry in a
 * registry. When a re-render replaces the leaf, the DOM's removing steps
 * re-point every range inside it at the surviving parent element rather than
 * invalidating it: the registry stays full, `Highlight.size` keeps counting,
 * `isConnected` keeps answering yes — and nothing is painted. Only "is the
 * boundary a text node inside this leaf" separates the two, which is why the
 * suite asked the wrong question for a while and the colours died on every
 * keystroke with a green build.
 */
const inLeaf = (page: Page) =>
  page.evaluate(() => {
    const leaf = document.querySelector('.nbe-t-code .nbe-leaf')!;
    let total = 0;
    let inLeaf = 0;
    for (const [name, highlight] of (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights) {
      if (!name.startsWith('nbe-code-')) continue;
      for (const range of highlight) {
        total++;
        if (range.startContainer.nodeType === Node.TEXT_NODE && leaf.contains(range.startContainer)) inLeaf++;
      }
    }
    return { total, inLeaf };
  });

test.describe('the code block', () => {
  test('``` opens one, from the plugin\'s own shortcut', async ({ page, editor }) => {
    await makeCode(page, editor);
    expect(await editor.types()).toEqual(['code']);
    expect(editor.errors()).toEqual([]);
  });

  test('colours the code without putting a single span in the leaf', async ({ page, editor }) => {
    await makeCode(page, editor);
    // pick a language, then type into it
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('javas');
    await page.locator('.nbe-menu button', { hasText: 'JavaScript' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('const x = 1;');

    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(1);
    const ranges = await painted(page);
    expect(ranges['nbe-code-keyword']).toBeGreaterThan(0);

    // the invariant: the leaf still holds plain text nodes and nothing else
    const markup = await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-t-code .nbe-leaf')!;
      return { spans: leaf.querySelectorAll('*').length, text: leaf.textContent };
    });
    expect(markup.spans).toBe(0);
    expect(markup.text).toBe('const x = 1;');
    expect(editor.errors()).toEqual([]);
  });

  test('Enter adds a line instead of splitting the block', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Enter');
    await page.keyboard.type('deux');
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('un\ndeux');
    expect(editor.errors()).toEqual([]);
  });

  test('Tab indents, Shift+Tab outdents — it never leaves the block', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    expect((await editor.texts())[0]).toBe('  x');
    await page.keyboard.press('Shift+Tab');
    expect((await editor.texts())[0]).toBe('x');
    expect(await editor.types()).toEqual(['code']);
    expect(editor.errors()).toEqual([]);
  });

  test('the caret survives typing in coloured code', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('python');
    await page.locator('.nbe-menu button', { hasText: 'Python' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('def f():');
    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(0);
    // typing continues where the caret was, which is the whole point of not
    // rewriting the DOM to colour it
    await page.keyboard.type(' pass');
    expect((await editor.texts())[0]).toBe('def f(): pass');
    expect(editor.errors()).toEqual([]);
  });

  test('Shift+Enter adds a line too — both spellings of "new line"', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('deux');
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('un\ndeux');
  });
});

/**
 * The clipboard, which the extraction into `@nbe/blocks-code` broke in both
 * directions: the copy path serialised through Markdown with no plugin
 * registry, and the paste path ran the Markdown parser over text going *into*
 * a block that holds literal characters.
 */
test.describe('the code block and the clipboard', () => {
  test('copying it puts the code on the clipboard, not a placeholder', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('const x = 1;');
    await page.keyboard.press('ControlOrMeta+a');

    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return { plain: dt.getData('text/plain'), html: dt.getData('text/html') };
    });
    expect(copied.plain).toContain('const x = 1;');
    expect(copied.plain).not.toContain('nbe:code'); // the "cannot say it" marker
    expect(copied.html).toContain('<pre><code>const x = 1;</code></pre>');
  });

  test('pasting into it inserts text, and does not parse Markdown', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '#!/bin/sh\n# setup\necho ok');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });

    // one block, still code, `#` intact — it used to become a heading
    expect(await editor.types()).toEqual(['code']);
    expect((await editor.texts())[0]).toBe('#!/bin/sh\n# setup\necho ok');
    expect(editor.errors()).toEqual([]);
  });

  test('the language filter keeps the focus while you type in it', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    const input = page.locator('.nbe-menu input');
    await input.click();
    // one character at a time: `fill()` sets the value in one shot and would
    // never have caught this — it took one character per click
    await page.keyboard.type('jav', { delay: 20 });

    await expect(input).toHaveValue('jav');
    await expect(input).toBeFocused();
    await expect(page.locator('.nbe-menu button', { hasText: 'JavaScript' })).toBeVisible();
  });
});

/**
 * What the colours actually depend on, and what the hover toolbar's menus do
 * when the page moves under them.
 */
test.describe('the code block, in the frame it is typed in', () => {
  test('a language written the way people write it still colours', async ({ page, editor }) => {
    // the demo seeds a block with `language: 'ts'`. `ts` is what a TypeScript
    // file's own README writes and it is an *alias* — it loaded no grammar at
    // all, so that block was never coloured. Not "late": never.
    await editor.reset();
    await page.locator('.nbe-t-code').first().waitFor();
    await expect.poll(async () => Object.keys(await painted(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(editor.errors()).toEqual([]);
  });

  test('every painted range is anchored in the code it colours', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('javas');
    await page.locator('.nbe-menu button', { hasText: 'JavaScript' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('const x = 1;');
    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(1);
    await page.keyboard.type(' let y = 2;');

    const live = await inLeaf(page);
    expect(live.total).toBeGreaterThan(0);
    expect(live.inLeaf).toBe(live.total);
    expect(editor.errors()).toEqual([]);
  });

  test('and after a render no transaction announced', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await page.locator('.nbe-menu input').fill('javas');
    await page.locator('.nbe-menu button', { hasText: 'JavaScript' }).first().click();
    await page.locator('.nbe-t-code .nbe-leaf').click();
    await page.keyboard.type('const x = 1;');
    await expect.poll(async () => Object.keys(await painted(page)).length).toBeGreaterThan(1);

    /*
     * An extension writing markup into the leaf: the view reverts it by
     * re-rendering the block, and no `Change` is emitted — the same shape as a
     * peer's edit arriving through `renderAll`, which is the one the editor
     * cannot reproduce from this side of the page. Anything measured from the
     * DOM has to hear about a render like this one or it is left pointing at
     * a leaf nobody kept.
     */
    await page.evaluate(() => {
      const leaf = document.querySelector('.nbe-t-code .nbe-leaf')!;
      leaf.append(document.createElement('span')); // same text, foreign markup
    });
    await expect.poll(async () => (await page.evaluate(() => document.querySelectorAll('.nbe-t-code .nbe-leaf span').length))).toBe(0);
    const live = await inLeaf(page);
    expect(live.total).toBeGreaterThan(0);
    expect(live.inLeaf).toBe(live.total);
    expect(editor.errors()).toEqual([]);
  });

  test('Enter really adds a line — the last one used to render as nothing', async ({ page, editor }) => {
    await makeCode(page, editor);
    await page.keyboard.type('un');
    const height = () =>
      page.evaluate(() => document.querySelector('.nbe-t-code .nbe-leaf')!.getBoundingClientRect().height);
    const one = await height();

    await page.keyboard.press('Enter');
    const two = await height();
    await page.keyboard.press('Shift+Enter');
    const three = await height();

    // a newline at the very end generates no line box unless something is on
    // it: the block stayed exactly one line tall and the caret had no rect
    expect(two).toBeGreaterThan(one + 5);
    expect(three).toBeGreaterThan(two + 5);
    expect((await editor.texts())[0]).toBe('un\n\n');
  });

  test('the language menu stays glued to its button when the page scrolls', async ({ page, editor }) => {
    // an empty first block for the ``` shortcut, then enough page to scroll
    await editor.setDocument(['', ...Array.from({ length: 40 }, (_, i) => `paragraphe ${i}`)]);
    await page.locator('.nbe-editor .nbe-leaf').first().click();
    await page.keyboard.type('```');
    await expect(page.locator('.nbe-t-code')).toBeVisible();

    await page.locator('.nbe-t-code').hover();
    await page.locator('.nbe-blocktoolbar-btn').first().click();
    await expect(page.locator('.nbe-menu')).toBeVisible();

    const read = async () => {
      const button = (await page.locator('.nbe-blocktoolbar-btn').first().boundingBox())!;
      const menu = (await page.locator('.nbe-menu').boundingBox())!;
      return { gap: menu.y - button.y, buttonY: button.y };
    };
    const before = await read();

    // the container that actually scrolls, for the reason gutter.spec.ts gives:
    // `mouse.wheel` moves `.page-scroll` on Chromium and moves nothing on
    // WebKit, and this test is about the menu's anchor, not about wheel dispatch
    await page.evaluate(() => {
      const scroller = document.querySelector('.page-scroll');
      if (!scroller) throw new Error('.page-scroll introuvable — le démonstrateur a changé');
      scroller.scrollTop += 120;
    });
    // what a real browser does under a stationary cursor once the page moves —
    // and what used to rebuild the toolbar, orphaning the menu's anchor
    await page.evaluate(() => {
      const el = document.elementFromPoint(200, 400);
      el?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 400 }));
    });
    await page.waitForTimeout(400); // past the toolbar's 250ms hide timer

    const after = await read();
    expect(Math.abs(after.buttonY - before.buttonY)).toBeGreaterThan(40);
    expect(Math.abs(after.gap - before.gap)).toBeLessThan(12);
  });
});

/**
 * Tab in a code block is an indent. A caret indents where it is; a selection
 * indents every line it touches, which is what anyone reaches for after
 * pasting. Outdent takes a real tab or spaces, because a file written
 * elsewhere is indented with whichever its author used.
 */
test.describe('the code block indents like an editor', () => {
  const write = async (page: Page, editor: { setDocument(p: string[]): Promise<void> }, lines: string[]) => {
    await makeCode(page, editor);
    for (const [i, line] of lines.entries()) {
      if (i) await page.keyboard.press('Enter');
      await page.keyboard.type(line);
    }
  };

  test('a selection indents every line it touches, and outdents them back', async ({ page, editor }) => {
    await write(page, editor, ['un', 'deux', 'trois']);
    // select from inside line 1 to inside line 2
    // the code block is the only block: one leaf, index 0
    await editor.selectRange([0, 1], [0, 8]);
    await page.keyboard.press('Tab');
    expect((await editor.texts())[0]).toBe('  un\n  deux\ntrois');

    await page.keyboard.press('Shift+Tab');
    expect((await editor.texts())[0]).toBe('un\ndeux\ntrois');
    expect(editor.errors()).toEqual([]);
  });

  test('the selection still covers the same lines afterwards', async ({ page, editor }) => {
    await write(page, editor, ['un', 'deux']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.keyboard.press('Tab');
    expect(await editor.selectionText()).toBe('  un\n  deux');
  });

  test('outdent takes a real tab as readily as spaces', async ({ page, editor }) => {
    await makeCode(page, editor);
    // a tab typed as a character, the way a paste from a file arrives
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '\tune ligne');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    expect((await editor.texts())[0]).toBe('\tune ligne');

    await editor.caret(0, 3);
    await page.keyboard.press('Shift+Tab');
    expect((await editor.texts())[0]).toBe('une ligne');
  });

  test('a caret still indents where it is, not at the line start', async ({ page, editor }) => {
    await write(page, editor, ['abcd']);
    await editor.caret(0, 2);
    await page.keyboard.press('Tab');
    expect((await editor.texts())[0]).toBe('ab  cd');
  });

  test('outdenting a line with no indent left changes nothing', async ({ page, editor }) => {
    await write(page, editor, ['un', 'deux']);
    await editor.selectRange([0, 0], [0, 7]);
    await page.keyboard.press('Shift+Tab');
    expect((await editor.texts())[0]).toBe('un\ndeux');
  });
});
