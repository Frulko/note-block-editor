import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The design charter, as rules a machine can hold us to.
 *
 * @remarks
 * The token layer's whole value is that a theme changes a short list of base
 * channels and everything else derives. That rule was already written in a
 * comment, and the file broke it anyway: some forty derived tokens were
 * restated inside each theme block, and they drifted — `--nbe-code-text` ended
 * up declared twice in a row. A comment cannot fail a build. These can.
 */

const STYLE_DIR = join(__dirname, '..', 'packages', 'dom', 'src', 'style');
const tokens = readFileSync(join(STYLE_DIR, 'tokens.css'), 'utf8');

/** The declarations inside every rule that sets a theme. */
function themeBlocks(css: string): string[] {
  const blocks: string[] = [];
  // a theme block is one that mentions data-nbe-theme, or sits in the dark media query
  const dark = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/.exec(css);
  if (dark) blocks.push(dark[1]!);
  for (const match of css.matchAll(/\[data-nbe-theme="(?:dark|light)"\][^{]*\{([\s\S]*?)\n\}/g)) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/** Custom properties declared in a chunk of CSS. */
function declared(chunk: string): string[] {
  return [...chunk.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
}

/**
 * What a theme is allowed to change.
 *
 * @remarks
 * Colours that cannot derive from anything (the surfaces), the `R G B` triplets
 * that other files consume as `rgb(var(--nbe-ink) / 0.4)`, and the alphas that
 * exist precisely so the tokens using them need not be restated per theme.
 */
const BASE_CHANNELS = new Set([
  '--nbe-ink',
  '--nbe-ink-warm',
  '--nbe-accent-rgb',
  '--nbe-danger-rgb',
  '--nbe-shadow-rgb',
  '--nbe-success-rgb',
  '--nbe-surface',
  '--nbe-surface-sunken',
  '--nbe-inverse-surface',
]);

const isAlpha = (name: string): boolean => name.startsWith('--nbe-a-');

describe('the token layer keeps its own rule', () => {
  it('a theme changes base channels only — everything else derives', () => {
    for (const block of themeBlocks(tokens)) {
      const offenders = declared(block).filter((name) => !BASE_CHANNELS.has(name) && !isAlpha(name));
      expect(offenders, 'derived tokens must not be restated per theme').toEqual([]);
    }
  });

  it('declares nothing twice in the same block', () => {
    const blocks = [...tokens.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
    for (const block of blocks) {
      const names = declared(block);
      expect(names.length, `duplicate declaration in:\n${block.slice(0, 200)}`).toBe(new Set(names).size);
    }
  });

  it('writes the named block palette once, via light-dark()', () => {
    // persisted by name, so eighteen colours × two themes is the biggest
    // duplication the old file carried
    for (const block of themeBlocks(tokens)) {
      expect(declared(block).filter((name) => name.startsWith('--nbe-color-'))).toEqual([]);
    }
    const palette = [...tokens.matchAll(/^\s*(--nbe-color-[a-z-]+)\s*:\s*([^;]+);/gm)];
    expect(palette.length).toBeGreaterThan(0);
    for (const [, name, value] of palette) {
      expect(value, `${name} should pick its side with light-dark()`).toContain('light-dark(');
    }
  });
});

describe('type is set from the charter, not per file', () => {
  it('no stylesheet hard-codes a font stack', () => {
    for (const file of readdirSync(STYLE_DIR).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(join(STYLE_DIR, file), 'utf8');
      for (const [line] of css.matchAll(/^.*font-family:.*$/gm)) {
        // the tokens file is where the stacks are allowed to be spelled out
        if (file === 'tokens.css') continue;
        expect(line, `${file} should use var(--nbe-font-*)`).toMatch(/var\(--nbe-font-/);
      }
    }
  });

  it('names Inter first and still works without it', () => {
    const stack = /--nbe-font-sans:([^;]+);/.exec(tokens)![1]!;
    expect(stack).toMatch(/^\s*"Inter"/);
    // a remote font is a network dependency in an offline-first editor, so the
    // stack has to survive Inter being absent
    expect(stack).toMatch(/ui-sans-serif|system-ui|-apple-system/);
    expect(tokens).not.toMatch(/@import|fonts\.googleapis|@font-face/);
  });
});
