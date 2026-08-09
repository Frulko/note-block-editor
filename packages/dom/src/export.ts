import { getBlock, plainText, visibleBlocks } from '@nbe/core';
import { blocksToMarkdown } from '@nbe/markdown';
import type { EditorView } from './view';
import type { EditorFeature } from './features';
import { createMenu } from './ui';
import { isMod } from './keymap';

/**
 * Take the page with you: `⌘P` offers the formats this document can become.
 *
 * @remarks
 * **Off by default.** `⌘P` is the browser's print dialog, and a page that
 * takes it away had better be offering more than a worse one — which is
 * exactly what this does, since printing is one of the four things on the
 * menu. A host opts in by adding {@link exportFeature} to its `features`.
 *
 * Three formats need nothing this package does not already have: Markdown
 * (`@nbe/markdown`, with the plugin registry, so a code block leaves as a
 * fence and not as a "cannot say it" marker), plain text, and PDF — which is
 * the browser's own print-to-PDF, because shipping a PDF engine to render a
 * page the browser can already render is a megabyte for nothing.
 *
 * HTML is not among them, and the reason is the layering: `@nbe/dom` may
 * depend on core and markdown, and on nothing else (CI asserts it). A host
 * that wants HTML passes it in — `createExport([{ id: 'html', … }])` — with
 * `@nbe/static-renderer`, which it may depend on and this package may not.
 *
 * @category Configuration
 */
export interface ExportFormat {
  /** Stable id; also the file extension when `text` is used. */
  id: string;
  label: string;
  /** The file's contents. Omit and provide `run` to do something else. */
  text?: (view: EditorView) => string;
  /** Anything that is not a file — printing, a host's own save dialog. */
  run?: (view: EditorView) => void;
}

/** The blocks of the open page, top level, in order. */
function topLevel(view: EditorView) {
  const doc = view.editor.doc;
  return getBlock(doc, doc.rootId).children.map((id) => getBlock(doc, id));
}

function download(name: string, contents: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // the object URL pins the blob in memory until it is let go
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename from the document's own title, or the host page's. */
function baseName(): string {
  const title = (document.title || 'page').replace(/[/\\:*?"<>|]/g, ' ').trim();
  return title.slice(0, 60) || 'page';
}

export const markdownFormat: ExportFormat = {
  id: 'md',
  label: 'Markdown (.md)',
  text: (view) =>
    blocksToMarkdown(topLevel(view) as never, { plugins: view.plugins }),
};

export const textFormat: ExportFormat = {
  id: 'txt',
  label: 'Texte (.txt)',
  text: (view) =>
    visibleBlocks(view.editor.doc)
      .map((block) => plainText(block.text))
      .join('\n'),
};

export const printFormat: ExportFormat = {
  id: 'pdf',
  label: 'PDF (impression)',
  run: (view) => {
    /*
     * The browser's own print-to-PDF. `nbe-printing` on <body> is what the
     * print stylesheet keys off, so only the document prints and not the
     * host's sidebar, toolbar and panels — a class rather than a rule about
     * `body > *`, because this package cannot know what a host puts there.
     */
    document.body.classList.add('nbe-printing');
    view.content.classList.add('nbe-print-target');
    const done = () => {
      document.body.classList.remove('nbe-printing');
      view.content.classList.remove('nbe-print-target');
      window.removeEventListener('afterprint', done);
      window.removeEventListener('focus', done);
    };
    window.addEventListener('afterprint', done);
    /*
     * Some configurations return from `print()` without ever firing
     * `afterprint`. The window getting focus back is the same fact observed
     * differently — an event, not a guess at how long a dialog stays up, which
     * is the sort of wall-clock coordination this codebase removed once.
     */
    window.addEventListener('focus', done);
    window.print();
  },
};

/** The three formats this package can produce on its own. */
export const defaultExportFormats: readonly ExportFormat[] = [markdownFormat, textFormat, printFormat];

/**
 * Build the feature, with whatever extra formats the host can offer.
 *
 * @example
 * ```ts
 * import { createExport } from '@nbe/dom'
 * import { renderToHTML } from '@nbe/static-renderer'
 *
 * createExport([{ id: 'html', label: 'HTML', text: (v) => renderToHTML(docToJSON(v.editor.doc)) }])
 * ```
 */
export function createExport(extra: readonly ExportFormat[] = []): EditorFeature {
  const formats = [...defaultExportFormats, ...extra];
  return {
    name: 'export',
    attach(view) {
      const menu = createMenu({ className: 'nbe-export-menu' });

      const choose = (format: ExportFormat) => {
        if (format.run) return format.run(view);
        if (!format.text) return;
        const mime = format.id === 'html' ? 'text/html' : format.id === 'md' ? 'text/markdown' : 'text/plain';
        download(`${baseName()}.${format.id}`, format.text(view), mime);
      };

      /*
       * Capture, and only while the editor has focus — see `search.ts`. A host
       * may already own this key (Obsidian's command palette is on it), and a
       * bubbling listener never sees a key the host has already taken.
       */
      const mine = () => {
        const active = document.activeElement;
        return !!active && (view.content.contains(active) || menu.el.contains(active));
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (!isMod(e) || e.key.toLowerCase() !== 'p' || e.altKey || e.shiftKey || !mine()) return;
        e.preventDefault();
        e.stopPropagation();
        menu.update(formats.map((format) => ({ label: format.label, onSelect: () => choose(format) })));
        menu.open(() => {
          const rect = view.content.getBoundingClientRect();
          return new DOMRect(rect.right - 12, rect.top + 8, 0, 0);
        }, { placement: 'bottom-end' });
      };

      document.addEventListener('keydown', onKeyDown, true);
      return () => {
        document.removeEventListener('keydown', onKeyDown, true);
        menu.close();
      };
    },
  };
}

/** `⌘P` offers Markdown, plain text and print-to-PDF. Not in `defaultFeatures`. */
export const exportFeature: EditorFeature = createExport();
