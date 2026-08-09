/**
 * The code block's editing behaviour: the language picker, copy, wrap, the
 * keys a code block owns, and the highlighter feature.
 *
 * This entry depends on `@nbe/dom`; the package's main entry does not.
 *
 * @module @nbe/blocks-code/dom
 */
import { getBlock, plainText, textCaret } from '@nbe/core';
import { createMenu, createMenuFilter, type DomBlockPlugin, type MenuEntry, type MenuFilter } from '@nbe/dom';
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
function languageMenu(
  current: string,
  choose: (id: string) => void,
): { menu: ReturnType<typeof createMenu>; render: (query: string) => void; filter: MenuFilter } {
  const menu = createMenu({ className: 'nbe-blocktoolbar-menu nbe-code-langmenu' });
  // the shared combobox field: it keeps the typing and hands the arrows and
  // Enter to the list, which is the only way to choose one without a mouse
  const filter = createMenuFilter({ placeholder: 'Langage…', onInput: (q) => render(q) });

  const render = (query: string) => {
    const q = query.toLowerCase().trim();
    const matches = LANGUAGES.filter((l) => !q || l.label.toLowerCase().includes(q) || l.id.includes(q));
    const entries: MenuEntry[] = [
      { kind: 'custom', el: filter.el },
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

  // everything that is not navigation is typing, and must not reach the editor
  filter.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') e.stopPropagation();
  });
  return { menu, render, filter };
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
      const numbered = block.props['lineNumbers'] === true;
      // line numbers force `pre`: a wrapped line is several lines on screen
      // and the gutter would drift a row further out of step with every one
      if (block.props['wrap'] === false || numbered) ctx.root.classList.add('nbe-code-nowrap');
      const language = String(block.props['language'] ?? 'plain');
      if (language !== 'plain') {
        const tag = document.createElement('div');
        tag.className = 'nbe-code-lang';
        tag.textContent = languageLabel(language);
        tag.setAttribute('contenteditable', 'false');
        ctx.root.append(tag);
      }

      /*
       * The numbers are a sibling of the leaf, never inside it.
       *
       * The whole design of this block rests on the leaf holding text nodes
       * and nothing else — that is what lets the colours be painted rather
       * than marked up, and what keeps the caret, the IME and the DOM→model
       * reconciler out of trouble. A number per line inside it would undo all
       * of that, so the gutter sits beside it: `contenteditable="false"`,
       * `user-select: none`, `aria-hidden`. A hand selection cannot reach it
       * and the Copy button serialises the model, so neither way of copying
       * picks the numbers up.
       */
      if (numbered) {
        ctx.root.classList.add('nbe-code-numbered');
        const gutter = document.createElement('div');
        gutter.className = 'nbe-code-gutter';
        gutter.setAttribute('contenteditable', 'false');
        gutter.setAttribute('aria-hidden', 'true');
        const lines = plainText(block.text).split('\n').length;
        for (let n = 1; n <= lines; n++) {
          const row = document.createElement('span');
          row.textContent = String(n);
          gutter.append(row);
        }
        ctx.root.prepend(gutter);
      }

      const caption = String(block.props['caption'] ?? '');
      if (caption) {
        const el = document.createElement('figcaption');
        el.className = 'nbe-code-caption';
        el.setAttribute('contenteditable', 'false');
        el.textContent = caption;
        ctx.root.append(el);
      }
    },

    keys: {
      /*
       * Backspace, as a plain-text editor means it.
       *
       * Two things were wrong, and both come from a code block being treated
       * as an ordinary block. `⌘⌫` deleted the **whole block** — the editor's
       * general binding, and the one thing you never want while editing code,
       * where the platform's own meaning is "delete to the start of the line".
       * And Backspace at offset 0 merged the code *into the prose above it*,
       * turning a program into a paragraph with no way back except undo.
       *
       * `metaKey` and not `isMod`: off a Mac, `Ctrl+⌫` is the word delete
       * every text field on the platform has, and taking it here would break
       * the one binding Linux and Windows cannot reach any other way.
       */
      Backspace: ({ view, block, event }) => {
        const sel = view.editor.selection;
        if (sel?.kind !== 'text' || sel.head.blockId !== block.id) return false;
        const from = Math.min(sel.anchor.offset, sel.head.offset);
        const to = Math.max(sel.anchor.offset, sel.head.offset);
        if (from !== to) return false; // a range delete is a range delete
        if (event.metaKey) {
          event.preventDefault();
          const start = plainText(block.text).lastIndexOf('\n', from - 1) + 1;
          if (start < from) {
            view.editor.dispatch((tx) => tx.op({ type: 'delete_text', id: block.id, from: start, to: from }), {
              origin: 'input',
              selection: textCaret(block.id, start),
            });
          }
          return true;
        }
        // at the very start there is nothing above *inside the block*, and
        // what is above it is prose. Escape then Backspace still deletes it.
        if (from === 0) {
          event.preventDefault();
          return true;
        }
        return false;
      },

      /**
       * Delete, symmetrically.
       *
       * At the end of the block it used to pull the *next block in* — so one
       * press turned the paragraph under a code sample into part of the
       * sample, prose and all.
       */
      Delete: ({ view, block, event }) => {
        const sel = view.editor.selection;
        if (sel?.kind !== 'text' || sel.head.blockId !== block.id) return false;
        const from = Math.min(sel.anchor.offset, sel.head.offset);
        const to = Math.max(sel.anchor.offset, sel.head.offset);
        if (from !== to) return false;
        const text = plainText(block.text);
        if (event.metaKey) {
          event.preventDefault();
          const nl = text.indexOf('\n', from);
          const end = nl === -1 ? text.length : nl;
          if (end > from) {
            view.editor.dispatch((tx) => tx.op({ type: 'delete_text', id: block.id, from, to: end }), {
              origin: 'input',
              selection: textCaret(block.id, from),
            });
          }
          return true;
        }
        if (from >= text.length) {
          event.preventDefault();
          return true;
        }
        return false;
      },

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
      /*
       * Tab is an indent, never a focus move and never a nest.
       *
       * A caret indents where it is, which is what every editor does. A
       * *selection* indents every line it touches, which is the one people
       * reach for after pasting — and the reason the edits are applied from
       * the last line backwards: an insertion at line 1 would move every
       * offset computed for the lines below it.
       *
       * Outdent takes one real tab or up to `INDENT` spaces, because a file
       * written elsewhere is indented with whichever its author used and both
       * survive the Markdown round trip intact.
       */
      Tab: ({ view, block, event }) => {
        event.preventDefault();
        const editor = view.editor;
        const sel = editor.selection;
        if (sel?.kind !== 'text' || sel.head.blockId !== block.id) return true;
        const text = plainText(block.text);
        const from = Math.min(sel.anchor.offset, sel.head.offset);
        const to = Math.max(sel.anchor.offset, sel.head.offset);

        if (from === to && !event.shiftKey) {
          editor.dispatch(
            (tx) => tx.op({ type: 'insert_text', id: block.id, offset: from, runs: [{ text: INDENT }] }),
            { origin: 'input', selection: textCaret(block.id, from + INDENT.length) },
          );
          return true;
        }

        const starts: number[] = [];
        for (let i = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1; i <= to; ) {
          // a selection that ends exactly at a line's start does not reach it
          if (i > from && i === to) break;
          starts.push(i);
          const next = text.indexOf('\n', i);
          if (next === -1 || next >= to) break;
          i = next + 1;
        }

        /** How much this line's indentation changes, in characters. */
        const shift = (start: number): number => {
          if (!event.shiftKey) return INDENT.length;
          const line = text.slice(start);
          if (line.startsWith('\t')) return -1;
          const spaces = line.length - line.replace(/^ +/, '').length;
          return -Math.min(INDENT.length, spaces);
        };

        const edits = starts.map((start) => ({ start, by: shift(start) })).filter((e) => e.by !== 0);
        if (!edits.length) return true;

        const head = edits[0]!.by;
        const total = edits.reduce((n, e) => n + e.by, 0);
        editor.dispatch(
          (tx) => {
            for (const { start, by } of [...edits].reverse()) {
              if (by > 0) tx.op({ type: 'insert_text', id: block.id, offset: start, runs: [{ text: INDENT }] });
              else tx.op({ type: 'delete_text', id: block.id, from: start, to: start - by });
            }
          },
          {
            origin: 'input',
            selection: {
              kind: 'text',
              /*
               * A selection that started at a line's start keeps it: the
               * indent goes *inside* what was selected, so whole lines stay
               * whole. Otherwise the anchor rides its own line's change, and
               * never before that line's start — an outdent must not pull it
               * up into the line above.
               */
              anchor: {
                blockId: block.id,
                offset: from === starts[0] ? starts[0]! : Math.max(starts[0]!, from + head),
              },
              head: { blockId: block.id, offset: Math.max(starts[0]!, to + total) },
            },
          },
        );
        return true;
      },
    },

    /*
     * Above the block, like a table's and for the same reason: a code block's
     * top-right corner is not spare room. It holds the language badge and the
     * first line of code, and the bar was drawn over both — hovering to reach
     * the copy button hid the thing you were about to copy.
     */
    toolbarPlacement: 'above',
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
            picker.filter.focus();
          },
        },
        {
          icon: 'corner-down-right',
          title: wrap ? 'Ne pas retourner à la ligne' : 'Retour à la ligne',
          active: !wrap,
          onClick: () => setProps({ wrap: wrap ? false : undefined }),
        },
        {
          icon: 'list',
          title: block.props['lineNumbers'] === true ? 'Masquer les numéros de ligne' : 'Numéros de ligne',
          active: block.props['lineNumbers'] === true,
          onClick: () => setProps({ lineNumbers: block.props['lineNumbers'] === true ? undefined : true }),
        },
        {
          icon: 'pilcrow',
          title: String(block.props['caption'] ?? '') ? view.labels.editCaption : view.labels.addCaption,
          active: !!String(block.props['caption'] ?? ''),
          onClick: (_ctx, button) => {
            const menu = createMenu({ className: 'nbe-blocktoolbar-menu' });
            const wrap = document.createElement('div');
            wrap.className = 'nbe-seltoolbar-linkform';
            const input = document.createElement('input');
            input.className = 'nbe-db-input';
            input.placeholder = view.labels.captionPlaceholder;
            input.value = String(block.props['caption'] ?? '');
            // everything that is not navigation is typing, and must not reach
            // the editor — the same rule the language filter follows
            input.addEventListener('keydown', (e) => {
              if (e.key !== 'Escape') e.stopPropagation();
              if (e.key !== 'Enter') return;
              e.preventDefault();
              menu.close();
              setProps({ caption: input.value.trim() || undefined });
            });
            wrap.append(input);
            menu.update([{ kind: 'custom', el: wrap }]);
            menu.open(() => button.getBoundingClientRect(), { placement: 'bottom-end' });
            requestAnimationFrame(() => input.focus());
          },
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

    /*
     * Two entries, one block type. A diagram is a code block whose language is
     * `mermaid` — that is what the file says and what `@nbe/blocks-mermaid`
     * draws — and hunting for it in a thirty-language picker is not a way to
     * find out. A preset is one array entry, which is the point of `props`.
     */
    slash: [
      { label: 'Code', keywords: ['code', 'snippet', 'programme'], icon: 'code' },
      {
        label: 'Diagramme (Mermaid)',
        keywords: ['mermaid', 'diagramme', 'schema', 'schéma', 'graph', 'flowchart'],
        icon: 'workflow',
        props: { language: 'mermaid' },
      },
    ],
    turnInto: { label: 'Code', icon: 'code' },
  },
};

/** @category Plugins */
export const codeDomBlocks: DomBlockPlugin[] = [code];
