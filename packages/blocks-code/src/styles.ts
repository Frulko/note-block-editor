/**
 * The code block's own stylesheet, injected when the plugin is registered.
 *
 * The palette resolves from the editor's token layer, so a theme override
 * re-colours the syntax with everything else instead of needing a second theme
 * file. Nine groups, one CSS variable each, dark values under the same media
 * query the rest of the editor uses.
 *
 * @module
 */


/**
 * The syntax themes a host may offer, beyond the default.
 *
 * @remarks
 * The default (`one`, One Light and One Dark) needs no attribute and is what
 * the rules above declare. The others are selected the same way the editor's
 * own theme is — an attribute on a host element — because that hook already
 * exists, already reaches the chrome portaled out of the editor, and needs no
 * option threading through three packages to work:
 *
 * ```ts
 * document.body.dataset.nbeCodeTheme = 'solarized'
 * ```
 *
 * Each is a *pair*. A dark syntax palette on a light page is unreadable, so a
 * theme names both and the page's own light/dark decides which applies —
 * `prefers-color-scheme` by default, `data-nbe-theme` when a host has said.
 *
 * @category Configuration
 */
export interface CodeTheme {
  /** The value for `data-nbe-code-theme`. */
  id: string;
  label: string;
  light: Record<TokenGroupName, string>;
  dark: Record<TokenGroupName, string>;
}

type TokenGroupName =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'name'
  | 'type'
  | 'property'
  | 'operator'
  | 'meta';

export const CODE_THEMES: readonly CodeTheme[] = [
  {
    id: 'one',
    label: 'One (défaut)',
    light: { keyword: '#a626a4', string: '#50a14f', comment: '#a0a1a7', number: '#986801', name: '#4078f2', type: '#c18401', property: '#e45649', operator: '#383a42', meta: '#0184bc' },
    dark: { keyword: '#c678dd', string: '#98c379', comment: '#7f848e', number: '#d19a66', name: '#61afef', type: '#e5c07b', property: '#e06c75', operator: '#abb2bf', meta: '#56b6c2' },
  },
  {
    id: 'github',
    label: 'GitHub',
    light: { keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', number: '#0550ae', name: '#8250df', type: '#953800', property: '#0550ae', operator: '#24292f', meta: '#116329' },
    dark: { keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', number: '#79c0ff', name: '#d2a8ff', type: '#ffa657', property: '#79c0ff', operator: '#c9d1d9', meta: '#7ee787' },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    light: { keyword: '#859900', string: '#2aa198', comment: '#93a1a1', number: '#d33682', name: '#268bd2', type: '#b58900', property: '#cb4b16', operator: '#657b83', meta: '#6c71c4' },
    dark: { keyword: '#859900', string: '#2aa198', comment: '#586e75', number: '#d33682', name: '#268bd2', type: '#b58900', property: '#cb4b16', operator: '#93a1a1', meta: '#6c71c4' },
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    light: { keyword: '#111', string: '#555', comment: '#9a9a9a', number: '#555', name: '#111', type: '#555', property: '#111', operator: '#777', meta: '#777' },
    dark: { keyword: '#f2f2f2', string: '#b9b9b9', comment: '#7a7a7a', number: '#b9b9b9', name: '#f2f2f2', type: '#b9b9b9', property: '#f2f2f2', operator: '#9a9a9a', meta: '#9a9a9a' },
  },
];

const vars = (palette: Record<TokenGroupName, string>): string =>
  Object.entries(palette)
    .map(([group, value]) => `  --nbe-code-${group}: ${value};`)
    .join('\n');

/*
 * Written by a loop rather than by hand: four themes times two modes times
 * nine groups is seventy-two declarations, and a table that drifts from its
 * selectors is the failure mode the token layer already learned once.
 *
 * Three selectors per mode, the same shape `tokens.css` uses: the media query
 * for "the OS decides", guarded so an explicit light theme wins inside it, and
 * the attribute for "the host decided", so the choice works in both directions.
 */
const themeRules = CODE_THEMES.filter((theme) => theme.id !== 'one')
  .map((theme) => {
    const scope = `[data-nbe-code-theme='${theme.id}']`;
    return `
${scope} .nbe-editor, .nbe-editor${scope} {
${vars(theme.light)}
}
@media (prefers-color-scheme: dark) {
  ${scope}:not([data-nbe-theme='light']) .nbe-editor,
  .nbe-editor${scope}:not([data-nbe-theme='light']) {
${vars(theme.dark)}
  }
}
[data-nbe-theme='dark']${scope} .nbe-editor,
[data-nbe-theme='dark'] ${scope} .nbe-editor,
${scope} .nbe-editor[data-nbe-theme='dark'],
.nbe-editor${scope}[data-nbe-theme='dark'] {
${vars(theme.dark)}
}`;
  })
  .join('\n');


export const codeStyles = `
.nbe-t-code {
  background: var(--nbe-code-bg);
  border-radius: 4px;
  padding: 16px;
  margin: 4px 0;
  position: relative;
}
.nbe-t-code .nbe-leaf {
  font-family: var(--nbe-font-mono);
  font-size: 0.85em;
  line-height: 1.6;
  /* code is written in lines, and a line break in code is content */
  white-space: pre-wrap;
  tab-size: 2;
}
/* wrap: false — long lines scroll instead of folding, and the block scrolls
   rather than the page */
.nbe-t-code.nbe-code-nowrap .nbe-leaf {
  white-space: pre;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
/* --- line numbers -------------------------------------------------------
   A grid, so the gutter and the code share rows without the numbers ever
   entering the leaf: the whole design of this block rests on that leaf holding
   text nodes and nothing else, which is what lets the colours be painted
   instead of marked up. user-select:none and aria-hidden keep the numbers
   out of a hand selection, and the Copy button serialises the model, so
   neither way of copying picks them up. */
.nbe-t-code.nbe-code-numbered {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 12px;
}
.nbe-code-gutter {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  font-family: var(--nbe-font-mono);
  font-size: 0.85em;
  line-height: 1.6;
  text-align: right;
  color: var(--nbe-text-faint);
  user-select: none;
  -webkit-user-select: none;
  font-variant-numeric: tabular-nums;
}
.nbe-code-numbered .nbe-leaf {
  grid-column: 2;
}
.nbe-code-numbered .nbe-code-caption {
  grid-column: 1 / -1;
}

/* the caption, under the code: what this listing *is*, which a language tag
   cannot say */
.nbe-code-caption {
  margin-top: 8px;
  font-size: 0.85em;
  line-height: 1.4;
  color: var(--nbe-text-light);
  user-select: none;
}

/* the language, shown in the corner: it is the block's most important prop and
   a hover toolbar is not discoverable enough to be its only home */
.nbe-code-lang {
  position: absolute;
  top: 6px;
  right: 10px;
  font-family: var(--nbe-font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--nbe-text-faint);
  user-select: none;
  pointer-events: none;
}

/* --- the palette ---------------------------------------------------------
   Nine groups (highlight.js emits ~50 scopes; see src/highlight.ts) and the
   colours are tokens, so a host theme moves them with everything else. */
.nbe-editor {
  --nbe-code-keyword: #a626a4;
  --nbe-code-string: #50a14f;
  --nbe-code-comment: #a0a1a7;
  --nbe-code-number: #986801;
  --nbe-code-name: #4078f2;
  --nbe-code-type: #c18401;
  --nbe-code-property: #e45649;
  --nbe-code-operator: #383a42;
  --nbe-code-meta: #0184bc;
}
@media (prefers-color-scheme: dark) {
  .nbe-editor {
    --nbe-code-keyword: #c678dd;
    --nbe-code-string: #98c379;
    --nbe-code-comment: #7f848e;
    --nbe-code-number: #d19a66;
    --nbe-code-name: #61afef;
    --nbe-code-type: #e5c07b;
    --nbe-code-property: #e06c75;
    --nbe-code-operator: #abb2bf;
    --nbe-code-meta: #56b6c2;
  }
}
[data-theme='dark'] .nbe-editor,
.nbe-editor[data-theme='dark'] {
  --nbe-code-keyword: #c678dd;
  --nbe-code-string: #98c379;
  --nbe-code-comment: #7f848e;
  --nbe-code-number: #d19a66;
  --nbe-code-name: #61afef;
  --nbe-code-type: #e5c07b;
  --nbe-code-property: #e06c75;
  --nbe-code-meta: #56b6c2;
  --nbe-code-operator: #abb2bf;
}

/* Painted ranges, not elements: no span is ever inserted into the leaf, which
   is what keeps the caret, the IME and the reconciler out of this entirely.
   ::highlight() supports colour but not font-style — no italic comments. */
::highlight(nbe-code-keyword) { color: var(--nbe-code-keyword); }
::highlight(nbe-code-string) { color: var(--nbe-code-string); }
::highlight(nbe-code-comment) { color: var(--nbe-code-comment); }
::highlight(nbe-code-number) { color: var(--nbe-code-number); }
::highlight(nbe-code-name) { color: var(--nbe-code-name); }
::highlight(nbe-code-type) { color: var(--nbe-code-type); }
::highlight(nbe-code-property) { color: var(--nbe-code-property); }
::highlight(nbe-code-operator) { color: var(--nbe-code-operator); }
::highlight(nbe-code-meta) { color: var(--nbe-code-meta); }

/* the same nine groups for the static export, which uses real spans */
.nbe-tok-keyword { color: var(--nbe-code-keyword, #a626a4); }
.nbe-tok-string { color: var(--nbe-code-string, #50a14f); }
.nbe-tok-comment { color: var(--nbe-code-comment, #a0a1a7); }
.nbe-tok-number { color: var(--nbe-code-number, #986801); }
.nbe-tok-name { color: var(--nbe-code-name, #4078f2); }
.nbe-tok-type { color: var(--nbe-code-type, #c18401); }
.nbe-tok-property { color: var(--nbe-code-property, #e45649); }
.nbe-tok-operator { color: var(--nbe-code-operator, #383a42); }
.nbe-tok-meta { color: var(--nbe-code-meta, #0184bc); }
` + themeRules;
