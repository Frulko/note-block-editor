import { test, expect } from './fixtures';

/**
 * Accepting a spellcheck correction.
 *
 * @remarks
 * `input.ts` blocks every input type it does not recognise, and names the cost:
 * *"insertReplacementText (spellcheck) support comes with the MutationObserver
 * path"*. That is the event a browser fires when someone right-clicks a
 * misspelled word and picks a correction — so the note describes a gap a person
 * can actually walk into, with spellcheck on by default in every contenteditable.
 *
 * This confirms the gap rather than assuming it, so that whoever closes it
 * knows what "closed" looks like.
 */
test('a spellcheck replacement reaches the model', async ({ page, editor }) => {
  await editor.setDocument(['un texte avec une fautte ici']);
  await page.locator('.nbe-leaf').first().click();

  await page.evaluate(() => {
    const leaf = document.querySelector('.nbe-leaf') as HTMLElement;
    const text = leaf.firstChild!;
    // select the misspelling, the way the browser does before replacing it
    const range = document.createRange();
    const at = (text.textContent ?? '').indexOf('fautte');
    range.setStart(text, at);
    range.setEnd(text, at + 'fautte'.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    leaf.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertReplacementText',
        data: 'faute',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(200);

  expect((await editor.texts())[0]).toBe('un texte avec une faute ici');
});
