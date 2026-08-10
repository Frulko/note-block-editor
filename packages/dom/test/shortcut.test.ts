// @vitest-environment happy-dom
//
// The bindings were cross-platform long before their labels were: `isMod`
// reads Command on a Mac and Control everywhere else, and every tooltip
// naming one said `⌘B` on all three platforms. A Windows reader was being
// told to press a key their keyboard does not have.
import { afterEach, describe, expect, it, vi } from 'vitest';

/** `shortcut`, as the module resolves it for a given platform. */
async function on(platform: string): Promise<(...keys: string[]) => string> {
  vi.stubGlobal('navigator', { platform, userAgent: platform });
  vi.resetModules();
  return (await import('../src/keymap')).shortcut;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a shortcut is spelled the way the platform spells it', () => {
  it('stacks the glyphs on a Mac', async () => {
    const shortcut = await on('MacIntel');
    expect(shortcut('Mod', 'B')).toBe('⌘B');
    expect(shortcut('Mod', 'Shift', 'ArrowUp')).toBe('⌘⇧↑');
    expect(shortcut('Backspace')).toBe('⌫');
  });

  it('spells them out everywhere else', async () => {
    const shortcut = await on('Win32');
    expect(shortcut('Mod', 'B')).toBe('Ctrl+B');
    expect(shortcut('Mod', 'Shift', 'ArrowUp')).toBe('Ctrl+Shift+↑');
  });

  it('leaves a key with no glyph as itself, upper-cased', async () => {
    const shortcut = await on('Linux x86_64');
    expect(shortcut('Mod', 'k')).toBe('Ctrl+K');
    expect(shortcut('Mod', '.')).toBe('Ctrl+.');
  });
});
