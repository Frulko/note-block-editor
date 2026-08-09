import { test, expect } from './fixtures';

/**
 * The command modifier, and what must be left alone.
 *
 * `Cmd`/`Ctrl` is the editor's modifier — but on a Mac, Control is *also* the
 * system's own text-editing keymap, and reading the two as one stole `^A`,
 * `^E`, `^K` and the rest from the browser. So one spec for each side: what the
 * editor claims, and what it must let through.
 */
test.describe('the command modifier', () => {
  test('Cmd/Ctrl+Backspace deletes the block, not the line', async ({ editor }) => {
    await editor.setDocument(['un', 'deux', 'trois']);
    await editor.caret(1, 2);
    await editor.press('ControlOrMeta+Backspace');

    expect(await editor.texts()).toEqual(['un', 'trois']);
    expect(editor.errors()).toEqual([]);
  });

  test('Cmd/Ctrl+Delete does the same from the other key', async ({ editor }) => {
    await editor.setDocument(['un', 'deux']);
    await editor.caret(0, 0);
    await editor.press('ControlOrMeta+Delete');

    expect(await editor.texts()).toEqual(['deux']);
  });

  test('a selection spanning blocks deletes all of them', async ({ page, editor }) => {
    await editor.setDocument(['un', 'deux', 'trois', 'quatre']);
    // dragged rather than set with `setBaseAndExtent`, which WebKit clamps to
    // the block it started in — the same reason cross-block-selection.spec.ts
    // drives this with a mouse
    const box = async (i: number) => (await page.locator('.nbe-editor .nbe-leaf').nth(i).boundingBox())!;
    const a = await box(1);
    const b = await box(2);
    await page.mouse.move(a.x + 4, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 20, a.y + a.height / 2, { steps: 4 });
    await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await editor.press('ControlOrMeta+Backspace');

    expect(await editor.texts()).toEqual(['un', 'quatre']);
  });
});

/**
 * The line bindings from VS Code and PhpStorm, applied to blocks. Aliases of
 * ⌘⇧↑/⌘⇧↓ and ⌘D, not replacements.
 */
test.describe('the VS Code line bindings move and copy blocks', () => {
  test('Alt+ArrowDown moves the block down', async ({ editor }) => {
    await editor.setDocument(['un', 'deux', 'trois']);
    await editor.caret(0, 1);
    await editor.press('Alt+ArrowDown');

    expect(await editor.texts()).toEqual(['deux', 'un', 'trois']);
    expect(editor.errors()).toEqual([]);
  });

  test('Alt+ArrowUp moves it back', async ({ editor }) => {
    await editor.setDocument(['un', 'deux', 'trois']);
    await editor.caret(2, 1);
    await editor.press('Alt+ArrowUp');

    expect(await editor.texts()).toEqual(['un', 'trois', 'deux']);
  });

  test('Shift+Alt+ArrowDown copies the block', async ({ editor }) => {
    await editor.setDocument(['un', 'deux']);
    await editor.caret(0, 1);
    await editor.press('Shift+Alt+ArrowDown');

    expect(await editor.texts()).toEqual(['un', 'un', 'deux']);
  });

  test('they work on a block selection too', async ({ editor }) => {
    await editor.setDocument(['un', 'deux', 'trois']);
    await editor.caret(0, 0);
    await editor.press('Escape'); // text → block selection
    await editor.press('Alt+ArrowDown');

    expect(await editor.texts()).toEqual(['deux', 'un', 'trois']);
  });
});

/**
 * Word and line deletes are the platform's, and it hands us the exact range it
 * meant. These ran nowhere before: every one was blocked by `beforeinput`'s
 * default arm.
 */
test.describe('word and line deletes', () => {
  test('Alt/Ctrl+Backspace deletes the word before the caret', async ({ editor }) => {
    await editor.setDocument(['bonjour tout le monde']);
    await editor.caret(0, 21);
    await editor.press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');

    expect(await editor.texts()).toEqual(['bonjour tout le ']);
    expect(editor.errors()).toEqual([]);
  });

  test('Alt/Ctrl+Delete deletes the word after the caret', async ({ editor }) => {
    await editor.setDocument(['bonjour tout le monde']);
    await editor.caret(0, 8);
    await editor.press(process.platform === 'darwin' ? 'Alt+Delete' : 'Control+Delete');

    expect(await editor.texts()).toEqual(['bonjour  le monde']);
  });
});

/**
 * macOS-only: these bindings belong to the platform, and the browser already
 * implements every one of them inside a contenteditable. The editor's job is
 * to not take them.
 */
test.describe('macOS Control bindings reach the browser', () => {
  test.skip(process.platform !== 'darwin', 'the bindings only exist on macOS');

  test('Ctrl+E goes to the end of the line instead of toggling code', async ({ editor }) => {
    await editor.setDocument(['bonjour']);
    await editor.caret(0, 0);
    await editor.press('Control+e');

    expect(await editor.caretAt()).toEqual({ index: 0, offset: 7 });
    expect(await editor.texts()).toEqual(['bonjour']);
  });

  test('Ctrl+A goes to the start of the line instead of selecting the block', async ({ editor }) => {
    await editor.setDocument(['bonjour']);
    await editor.caret(0, 7);
    await editor.press('Control+a');

    expect(await editor.caretAt()).toEqual({ index: 0, offset: 0 });
    expect(await editor.selectionText()).toBe('');
  });

  test('Ctrl+K kills to the end of the line', async ({ editor, browserName }) => {
    /*
     * Measured: Playwright's WebKit answers `^K` with `deleteContentForward` —
     * one character, not a kill. Which key produces which `beforeinput` is the
     * engine's decision and not ours; what this asserts is that we honour a
     * hard-line delete when we are handed one, and only Chromium hands one over
     * on this key.
     */
    test.skip(browserName === 'webkit', 'WebKit sends deleteContentForward for ^K');
    await editor.setDocument(['bonjour tout le monde']);
    await editor.caret(0, 8);
    await editor.press('Control+k');

    expect(await editor.texts()).toEqual(['bonjour ']);
  });
});
