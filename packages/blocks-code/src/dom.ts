/**
 * The code block's editing behaviour: the language picker, copy, wrap, the
 * keys a code block owns, and the highlighter feature.
 *
 * This entry depends on `@nbe/dom`; the package's main entry does not.
 *
 * @module @nbe/blocks-code/dom
 */
import { getBlock, plainText, textCaret } from '@nbe/core';
import { createMenu, type DomBlockPlugin, type MenuEntry } from '@nbe/dom';
import { codePlugin } from './index';
import { LANGUAGES, languageLabel, loadLanguage } from './highlight';
import { attachCodeHighlight } from './paint';
import { codeStyles } from './styles';

/** Two spaces: the indent a code block uses when Tab is pressed. */
const INDENT = '  ';

/**
 * The language menu, filtered as you type.
 *
 * @remarks
 * Thirty languages is past the point where a list is browsable, and the id is
 * usually what someone knows ("ts", "py"), so the filter matches both the
 * label and the id. Picking one loads its grammar before setting the prop, so
 * the colours appear with the choice rather than a frame later.
 */
function languageMenu(current: string, choose: (id: string) => void): { menu: ReturnType<typeof createMenu>; render: (query: string) => void } {
  const menu = createMenu({ className: 'nbe-blocktoolbar-menu nbe-code-langmenu' });
  const field = document.createElement('div');
  field.className = 'nbe-db-filter';
  const input = document.createElement('input');
  input.className = 'nbe-db-input';
  input.placeholder = 'Langage…';
  field.append(input);

  const render = (query: string) => {
    const q = query.toLowerCase().trim();
    const matches = LANGUAGES.filter((l) => !q || l.label.toLowerCase().includes(q) || l.id.includes(q));
    const entries: MenuEntry[] = [
      { kind: 'custom', el: field },
      ...matches.slice(0, 12).map((l) => ({
        label: l.label,
        hintIcon: l.id === current ? 'check' : undefined,
        // load first, then set: the colours arrive with the choice rather
        // than a frame after it
        onSelect: () => void loadLanguage(l.id).then(() => choose(l.id)),
      })),
    ];
    if (!matches.length) entries.push({ kind: 'section', label: 'Aucun langage' });
    menu.update(entries);
  };

  input.addEventListener('keydown', (e) => {
    // the menu owns Enter and the arrows; everything else is typing
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') e.stopPropagation();
  });
  input.addEventListener('input', () => render(input.value));
  return { menu, render };
}

/**
 * The code block, ready to mount.
 *
 * @example
 * ```ts
 * import { code } from '@nbe/blocks-code/dom'
 * new EditorView(el, editor, { blocks: [...builtinBlocks, code] })
 * ```
 *
 * @category Plugins
 */
export const code: DomBlockPlugin = {
  ...codePlugin,
  view: {
    styles: codeStyles,
    // one feature for the whole document: the painter keeps a range set per
    // block and repaints only what a change touched
    features: [{ name: 'code-highlight', attach: attachCodeHighlight }],

    decorate(ctx, block) {
      if (block.props['wrap'] === false) ctx.root.classList.add('nbe-code-nowrap');
      const language = String(block.props['language'] ?? 'plain');
      if (language !== 'plain') {
        const tag = document.createElement('div');
        tag.className = 'nbe-code-lang';
        tag.textContent = languageLabel(language);
        tag.setAttribute('contenteditable', 'false');
        ctx.root.append(tag);
      }
    },

    keys: {
      // Enter inserts a newline instead of splitting: a code block is one
      // block whatever its line count, which is what makes the fence
      // projection and the caret arithmetic agree
      Enter: ({ view, block, event }) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) return false;
        const sel = view.editor.selection;
        if (sel?.kind !== 'text' || sel.head.blockId !== block.id) return false;
        event.preventDefault();
        const at = Math.min(sel.anchor.offset, sel.head.offset);
        const to = Math.max(sel.anchor.offset, sel.head.offset);
        view.editor.dispatch(
          (tx) => {
            if (at < to) tx.op({ type: 'delete_text', id: block.id, from: at, to });
            tx.op({ type: 'insert_text', id: block.id, offset: at, runs: [{ text: '\n' }] });
          },
          { origin: 'input', selection: textCaret(block.id, at + 1) },
        );
        return true;
      },
      // Tab indents rather than moving focus or nesting the block
      Tab: ({ view, block, event }) => {
        event.preventDefault();
        const sel = view.editor.selection;
        if (sel?.kind !== 'text') return true;
        const text = plainText(block.text);
        const caret = sel.head.offset;
        const lineStart = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
        if (event.shiftKey) {
          const outdent = text.slice(lineStart, lineStart + INDENT.length) === INDENT ? INDENT.length : 0;
          if (!outdent) return true;
          view.editor.dispatch(
            (tx) => tx.op({ type: 'delete_text', id: block.id, from: lineStart, to: lineStart + outdent }),
            { origin: 'input', selection: textCaret(block.id, Math.max(lineStart, caret - outdent)) },
          );
          return true;
        }
        view.editor.dispatch(
          (tx) => tx.op({ type: 'insert_text', id: block.id, offset: caret, runs: [{ text: INDENT }] }),
          { origin: 'input', selection: textCaret(block.id, caret + INDENT.length) },
        );
        return true;
      },
    },

    toolbar({ block, view, setProps }) {
      const language = String(block.props['language'] ?? 'plain');
      const wrap = block.props['wrap'] !== false;
      return [
        {
          icon: 'code',
          title: languageLabel(language),
          onClick: (_ctx, button) => {
            const picker = languageMenu(language, (id) => setProps({ language: id }));
            picker.render('');
            picker.menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
            queueMicrotask(() => picker.menu.el.querySelector('input')?.focus());
          },
        },
        {
          icon: 'corner-down-right',
          title: wrap ? 'Ne pas retourner à la ligne' : 'Retour à la ligne',
          active: !wrap,
          onClick: () => setProps({ wrap: wrap ? false : undefined }),
        },
        {
          icon: 'copy',
          title: 'Copier le code',
          onClick: () => {
            const text = plainText(getBlock(view.editor.doc, block.id).text);
            void navigator.clipboard?.writeText(text);
          },
        },
      ];
    },

    actions(ctx) {
      const current = String(ctx.block.props['language'] ?? 'plain');
      return [
        { kind: 'section', label: ctx.view.labels.language },
        ...LANGUAGES.map((l) => ({
          label: l.label,
          hintIcon: l.id === current ? 'check' : undefined,
          onSelect: () => {
            void loadLanguage(l.id);
            ctx.setProps({ language: l.id });
          },
        })),
      ];
    },

    slash: { label: 'Code', keywords: ['code', 'snippet', 'programme'], icon: 'code' },
    turnInto: { label: 'Code', icon: 'code' },
  },
};

/** @category Plugins */
export const codeDomBlocks: DomBlockPlugin[] = [code];
