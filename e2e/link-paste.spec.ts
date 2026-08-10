import { test, expect } from './fixtures';

/**
 * What a pasted link was meant to be.
 *
 * The same `https://…` is a citation in a sentence, a video to watch here, a
 * bookmark to come back to, or a page in this vault — and the editor cannot
 * tell them apart. Guessing picks wrong three times in four and every wrong
 * guess is an edit to undo, so the paste does the safe thing and *then* offers
 * the rest. The offer must never be in the way: typing on leaves the link
 * exactly as the paste made it.
 */
const paste = (page: import('@playwright/test').Page, text: string) =>
  page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);

test.describe('a pasted link', () => {
  test('lands as a link, and offers what else it could be', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');

    // the safe thing has already happened
    await expect(page.locator('.nbe-m-link')).toHaveText('https://vimeo.com/76979871');
    const menu = page.locator('.nbe-linkpaste-menu');
    await expect(menu).toBeVisible();
    /*
     * Alone on a line, a URL is something you pasted to look at, so the block
     * treatments lead — Enter takes the first entry, which makes the order the
     * default. « Lien court » is offered too but comes after them; in the
     * middle of a sentence the two swap.
     */
    await expect(menu.locator('.nbe-menu-item')).toHaveText([
      'Intégration',
      'Signet',
      /Lien court/,
      'Lien simple',
    ]);
    expect(editor.errors()).toEqual([]);
  });

  test('Escape leaves the link exactly as the paste made it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.keyboard.press('Escape');

    await expect(page.locator('.nbe-linkpaste-menu')).toHaveCount(0);
    expect(await editor.types()).toEqual(['paragraph']);
    expect((await editor.texts())[0]).toBe('https://vimeo.com/76979871');
  });

  test('choosing the embed replaces the paragraph it was alone in', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Intégration' }).click();

    await expect(page.locator('.nbe-embed-frame')).toHaveAttribute(
      'src',
      'https://player.vimeo.com/video/76979871',
    );
    // the empty paragraph it came out of went with it
    expect(await editor.types()).toEqual(['embed']);
  });

  test('a bookmark keeps the paragraph it was pasted into', async ({ page, editor }) => {
    await editor.setDocument(['une phrase avec ']);
    await editor.caret(0, 16);
    await paste(page, 'https://gist.github.com/anne/abc');
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Signet' }).click();

    expect(await editor.types()).toEqual(['paragraph', 'embed']);
    expect((await editor.texts())[0]).toBe('une phrase avec ');
    await expect(page.locator('.nbe-embed-card')).toHaveCount(1);
  });

  test('the keyboard drives it', async ({ page, editor }) => {
    await editor.setDocument(['']);
    await editor.caret(0, 0);
    await paste(page, 'https://vimeo.com/76979871');
    await page.keyboard.press('Enter');
    await expect(page.locator('.nbe-embed-frame')).toHaveCount(1);
  });
});

test.describe('a link already in the document', () => {
  test('a paragraph that is nothing but a link offers the same conversion', async ({ page, editor }) => {
    await editor.setDocument(['https://vimeo.com/76979871', 'de la prose']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    await page.locator('.nbe-menu-item', { hasText: 'Transformer en intégration' }).click();
    await page.locator('.nbe-linkpaste-menu .nbe-menu-item', { hasText: 'Intégration' }).click();

    expect(await editor.types()).toEqual(['embed', 'paragraph']);
  });

  test('and an ordinary paragraph does not', async ({ page, editor }) => {
    await editor.setDocument(['de la prose ordinaire']);
    await page.locator('.nbe-editor > .nbe-block').first().hover();
    await page.locator('.nbe-handle').click();
    await expect(page.locator('.nbe-menu-item', { hasText: 'Transformer en intégration' })).toHaveCount(0);
  });
});

/**
 * A URL dropped into the middle of a sentence, made readable.
 *
 * @remarks
 * The paste already offered what a link could *become* — a mention, an embed, a
 * bookmark — and nothing for what it should *read as* while staying inline,
 * which is what a URL in the middle of a sentence usually is. So it stayed a
 * forty-character `https://…` with a tracking query in it.
 *
 * Both new choices are ordinary Markdown links with a different text, so
 * nothing is stored and the file round-trips: `[example.com/article](https://…)`.
 */
test.describe('what a pasted link reads as', () => {
  const LONG = 'https://www.example.com/blog/un-article?utm_source=x';

  async function pasteInSentence(page: import('@playwright/test').Page, editor: import('./fixtures').Editor) {
    await editor.setDocument(['Voir  pour la suite.']);
    await editor.caret(0, 5);
    await page.evaluate((url) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', url);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, LONG);
    await page.locator('.nbe-linkpaste-menu').waitFor();
  }

  test('« Lien court » drops the scheme and the query, and keeps the href', async ({ page, editor }) => {
    await pasteInSentence(page, editor);
    await page.locator('.nbe-menu-item', { hasText: 'Lien court' }).click();

    const link = page.locator('.nbe-editor a.nbe-m-link');
    await expect(link).toHaveText('example.com/un-article');
    await expect(link).toHaveAttribute('href', LONG);
    // and it is still one sentence, not a block
    expect(await editor.texts()).toEqual(['Voir example.com/un-article pour la suite.']);
    expect(editor.errors()).toEqual([]);
  });

  test('the short text is shown in the menu before choosing it', async ({ page, editor }) => {
    await pasteInSentence(page, editor);
    // the hint says what you would get, which is the thing worth knowing
    await expect(page.locator('.nbe-menu-item', { hasText: 'Lien court' })).toContainText(
      'example.com/un-article',
    );
  });

  test('« Titre de la page » is absent when no host can fetch one', async ({ page, editor }) => {
    // the demo has no `onResolveLink`: a browser cannot read another origin,
    // so the entry is missing rather than present and dead
    await pasteInSentence(page, editor);
    await expect(page.locator('.nbe-menu-item', { hasText: 'Titre de la page' })).toHaveCount(0);
  });

  test('in a sentence the inline treatments lead, because Enter takes the first', async ({ page, editor }) => {
    await pasteInSentence(page, editor);
    /*
     * The order *is* the default. Turning a link that sits inside a sentence
     * into a block would tear the sentence in half, so the block treatments
     * cannot be what Enter reaches for here — where alone on a line they are.
     */
    await expect(page.locator('.nbe-linkpaste-menu .nbe-menu-item').first()).toContainText('Lien court');
  });

  test('choosing nothing leaves the link exactly as the paste made it', async ({ page, editor }) => {
    await pasteInSentence(page, editor);
    await page.keyboard.press('Escape');
    await expect(page.locator('.nbe-editor a.nbe-m-link')).toHaveText(LONG);
  });
});
