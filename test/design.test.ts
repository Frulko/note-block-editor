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
  '--nbe-note-rgb',
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

describe('the interface draws its icons', () => {
  /** Every source file in the DOM package, recursively. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  /**
   * The emoji palette is the one place emoji belong.
   *
   * @remarks
   * It offers them to the *user*, for their own page and callout icons. That is
   * content, not chrome, and removing it would take a feature away rather than
   * improve a design.
   */
  const CONTENT_NOT_CHROME = /ui[/\\]icon-picker\.ts$/;

  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{FF0B}]/u;

  it('uses Lucide, not emoji, everywhere it speaks for itself', () => {
    const offenders: string[] = [];
    for (const file of sources(join(__dirname, '..', 'packages', 'dom', 'src'))) {
      if (CONTENT_NOT_CHROME.test(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (EMOJI.test(line)) offenders.push(`${file.split('/src/')[1]}: ${line.trim().slice(0, 70)}`);
      }
    }
    // an emoji is a font glyph: it arrives in the platform's style, changes
    // shape per OS, ignores currentColor, and will not align to a baseline
    expect(offenders).toEqual([]);
  });
});

describe('motion speaks one language', () => {
  const SHEETS = readdirSync(STYLE_DIR).filter((name) => name.endsWith('.css') && name !== 'tokens.css');

  /** Every `transition:` / `animation:` declaration outside the token file. */
  function declarations(): Array<{ file: string; decl: string }> {
    return SHEETS.flatMap((file) =>
      [...readFileSync(join(STYLE_DIR, file), 'utf8').matchAll(/(?:transition|animation)\s*:[^;]+;/g)].map(
        (match) => ({ file, decl: match[0].replace(/\s+/g, ' ') }),
      ),
    );
  }

  it('states no duration of its own', () => {
    // three durations exist, in the charter. A fourth invented at a call site
    // is how an interface ends up feeling like several interfaces
    const offenders = declarations().filter(({ decl }) => /\b\d+m?s\b/.test(decl));
    expect(offenders.map((o) => `${o.file}: ${o.decl}`)).toEqual([]);
  });

  it('states no easing of its own', () => {
    const offenders = declarations().filter(({ decl }) =>
      /(?<![-\w])(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)(?![-\w])/.test(decl),
    );
    expect(offenders.map((o) => `${o.file}: ${o.decl}`)).toEqual([]);
  });

  it('reserves the overshoot curve for transforms', () => {
    // `--nbe-enter` overshoots past its end value. On opacity that would exceed
    // 1 and clamp — motion that costs a curve and shows nothing.
    const css = SHEETS.map((file) => readFileSync(join(STYLE_DIR, file), 'utf8')).join('\n');
    const animated = new Set(
      [...css.matchAll(/animation:\s*([\w-]+)[^;]*var\(--nbe-enter\)/g)].map((match) => match[1]!),
    );
    for (const name of animated) {
      const frames = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
      expect(frames, `${name} should be defined in these sheets`).toBeTruthy();
      expect(frames![1], `${name} overshoots, so it must move something`).toMatch(/transform/);
    }
  });
});

/**
 * Carnet inside Obsidian repaints the portaled chrome with the page's own ink,
 * because app.css styles bare `button` above anything a class can say and the
 * components rely on `color: inherit`. That blanket rule is right for every
 * surface except the inverted ones, where the page's ink is the *background*.
 *
 * Getting it wrong is silent: every tooltip in the vault was a black rectangle
 * with black text in it, no error anywhere. So the list is checked rather than
 * remembered — add an inverse surface to the editor and this fails until the
 * plugin sheet names it.
 */
describe('the Obsidian sheet covers every inverted surface', () => {
  const STYLE_DIR = join(__dirname, '..', 'packages', 'dom', 'src', 'style');
  const editorCss = readdirSync(STYLE_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(STYLE_DIR, name), 'utf8'))
    .join('\n');
  const pluginCss = readFileSync(join(__dirname, '..', 'apps', 'obsidian', 'src', 'styles.css'), 'utf8');

  /** Selectors whose own rule paints `--nbe-inverse-surface` as background. */
  function invertedSurfaces(): string[] {
    const out: string[] = [];
    for (const [, selector, body] of editorCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/background[^;]*--nbe-inverse-surface/.test(body!)) continue;
      out.push(...(selector!.match(/\.nbe-[\w-]+/g) ?? []));
    }
    return [...new Set(out)];
  }

  it('gives each of them the inverse ink back', () => {
    const surfaces = invertedSurfaces();
    expect(surfaces.length).toBeGreaterThan(0); // the regex still matches something
    const missing = surfaces.filter((selector) => {
      const rule = new RegExp(`\\${selector}[^{}]*\\{[^{}]*--nbe-inverse-text`);
      return !rule.test(pluginCss);
    });
    expect(missing).toEqual([]);
  });
});

/**
 * The vault's theme reaches Carnet, and a vault that does not have a variable
 * does not take the colour away.
 *
 * @remarks
 * A `var()` with no fallback whose name is undefined makes the declaration
 * *invalid at computed-value time* — which does not fall back to the previous
 * rule, it inherits. Inheriting a colour from an Obsidian pane is how a note
 * ends up with chrome nobody can read and nothing in the console. So the rule
 * is mechanical: every Obsidian variable the bridge reads names Carnet's own
 * value as its fallback.
 */
describe('the Obsidian theme bridge', () => {
  const pluginCss = readFileSync(join(__dirname, '..', 'apps', 'obsidian', 'src', 'styles.css'), 'utf8');

  /** The `--nbe-*: …` declarations that map onto an Obsidian variable. */
  function mappings(): Array<[name: string, value: string]> {
    return [...pluginCss.matchAll(/^\s*(--nbe-[\w-]+)\s*:\s*([^;]+);/gm)]
      .map(([, name, value]) => [name!, value!.replace(/\s+/g, ' ').trim()] as [string, string])
      .filter(([, value]) => /var\(--(?!nbe-)/.test(value));
  }

  it('maps more than the two surfaces it started with', () => {
    // a theme that changed the paper and nothing drawn on it was the bug
    expect(mappings().length).toBeGreaterThan(10);
  });

  it('gives every Obsidian variable it reads a fallback', () => {
    const naked = mappings().filter(([, value]) =>
      // a var() reference to a non-nbe name with no comma inside its parens
      [...value.matchAll(/var\(\s*--(?!nbe-)[\w-]+\s*\)/g)].length > 0,
    );
    expect(naked.map(([name, value]) => `${name}: ${value}`)).toEqual([]);
  });
});

/**
 * A table and its selectors, kept in step.
 *
 * @remarks
 * The token layer already learned this once: a list of values in TypeScript and
 * the CSS rules that read them drift, and nothing in a diff says so — you find
 * out when a setting in a dropdown does nothing. `CODE_THEMES` is generated
 * from its table for that reason. `TYPEFACES` is small enough to be written by
 * hand, so the check is here instead.
 */
describe('the typeface choice reaches the stylesheet', () => {
  const tokens = readFileSync(join(__dirname, '..', 'packages', 'dom', 'src', 'style', 'tokens.css'), 'utf8');
  const source = readFileSync(join(__dirname, '..', 'packages', 'dom', 'src', 'typography.ts'), 'utf8');
  const ids = [...source.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]!);

  it('offers the three faces the token layer declares', () => {
    expect(ids).toEqual(['sans', 'serif', 'mono']);
  });

  it('every id but the default has a rule', () => {
    // `sans` is what `--nbe-font-body` already is; a rule restating it would be
    // the duplication the base block exists to avoid
    for (const id of ids.filter((i) => i !== 'sans')) {
      expect(tokens, `[data-nbe-typeface="${id}"] should set --nbe-font-body`).toMatch(
        new RegExp(`\\[data-nbe-typeface="${id}"\\][\\s\\S]{0,400}--nbe-font-body`),
      );
    }
  });

  it('switches the prose only — a listing stays monospaced', () => {
    // the whole reason a code block is monospaced is that its columns mean
    // something, and `--nbe-font-mono` is what it reads
    const rules = tokens.slice(tokens.indexOf('[data-nbe-typeface='));
    expect(rules).not.toMatch(/--nbe-font-mono\s*:/);
  });
});

/**
 * The two colours the vault does not get to set.
 *
 * @remarks
 * `--nbe-code-bg` and `--nbe-code-text` were once mapped onto Obsidian's
 * `--code-background` and `--code-normal`, and it looked like an obvious pair
 * because the names line up. They do not mean the same thing: Obsidian's
 * describe a *fenced code block* in its renderer — background nearly the page,
 * ink the body ink, because a syntax palette paints over it afterwards — while
 * Carnet's are the **inline code mark**, a warm tint and red ink, which is the
 * whole of what makes `` `const` `` in a sentence read as code.
 *
 * Bridging them gave inline code the page's own colours: no tint, no ink,
 * indistinguishable from the prose. Reported 2026-08-10 as « il faut remettre
 * le bon style pour l'affichage de code inline ».
 *
 * A mapping made by name rather than by meaning is exactly the kind that gets
 * re-added by someone reading a list of Obsidian variables, so it is checked
 * rather than remembered.
 */
describe('the Obsidian bridge leaves the code colours alone', () => {
  const pluginCss = readFileSync(join(__dirname, '..', 'apps', 'obsidian', 'src', 'styles.css'), 'utf8');

  it('maps neither --nbe-code-bg nor --nbe-code-text', () => {
    const mapped = [...pluginCss.matchAll(/^\s*(--nbe-code-(?:bg|text))\s*:\s*([^;]+);/gm)].map(
      ([, name, value]) => `${name}: ${value!.trim()}`,
    );
    expect(mapped).toEqual([]);
  });

  it('and the token layer still states them, so there is something to keep', () => {
    const tokens = readFileSync(join(__dirname, '..', 'packages', 'dom', 'src', 'style', 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--nbe-code-bg\s*:/);
    expect(tokens).toMatch(/--nbe-code-text\s*:/);
  });

  it('the palette layer can be turned off without taking the paper with it', () => {
    // two layers: the surfaces and the faces are unconditional, the palette is
    // behind the opt-out — so « garder la palette Carnet » is not « ignorer le
    // thème du coffre »
    expect(pluginCss).toMatch(/body:not\(\[data-carnet-palette="carnet"\]\)/);
    const always = /\.carnet-host \.nbe-editor,[\s\S]*?body\[data-nbe-theme\] \.nbe-portal \{([\s\S]*?)\n\}/.exec(
      pluginCss,
    )![1]!;
    expect(always).toMatch(/--nbe-surface\s*:/);
    expect(always).toMatch(/--nbe-font-sans\s*:/);
    expect(always).not.toMatch(/--nbe-accent\s*:/);
  });
});
