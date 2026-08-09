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
`;
