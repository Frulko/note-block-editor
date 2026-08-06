import type { Block, BlockJSON, BlockId, Mark, Run } from '@nbe/core';
import {
  blockToJSON,
  childIndex,
  deleteBlocks,
  getBlock,
  selectedBlocks,
  sliceRuns,
  textCaret,
  textLength,
  uuidv7,
} from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks, runsToMarkdown } from '@nbe/markdown';
import type { EditorView } from './view';
import { leafOf } from './selection';

// --- copy: three formats at once (ARCHITECTURE §7) ---

interface Slice {
  blocks: BlockJSON[];
  /** True when the slice is a partial text range (pastes inline at a caret). */
  inline: boolean;
}

function buildSlice(view: EditorView): Slice | null {
  const editor = view.editor;
  const sel = editor.selection;
  if (sel?.kind === 'block') {
    const ids = selectedBlocks(editor.doc, sel);
    if (!ids.length) return null;
    return { blocks: ids.map((id) => blockToJSON(editor.doc, id)), inline: false };
  }
  if (sel?.kind === 'text' && sel.anchor.blockId === sel.head.blockId) {
    const from = Math.min(sel.anchor.offset, sel.head.offset);
    const to = Math.max(sel.anchor.offset, sel.head.offset);
    if (from === to) return null;
    const block = getBlock(editor.doc, sel.anchor.blockId);
    const runs = sliceRuns(block.text ?? [], from, to);
    const full = from === 0 && to === textLength(block.text);
    return {
      blocks: [{ id: block.id, type: full ? block.type : 'paragraph', version: 1, props: full ? block.props : {}, text: runs }],
      inline: !full,
    };
  }
  return null;
}

const MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
};

function runsToHtml(runs: Run[] | undefined): string {
  return (runs ?? [])
    .map((r) => {
      let html = escapeHtml(r.text);
      for (const m of r.marks ?? []) {
        if (m.type === 'link') html = `<a href="${escapeHtml(String(m.attrs?.['href'] ?? '#'))}">${html}</a>`;
        else if (MARK_TAGS[m.type]) html = `<${MARK_TAGS[m.type]}>${html}</${MARK_TAGS[m.type]}>`;
      }
      return html;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blocksToHtml(blocks: BlockJSON[]): string {
  const one = (b: BlockJSON): string => {
    const kids = (b.children ?? []).map(one).join('');
    const inner = runsToHtml(b.text);
    switch (b.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(b.props?.['level'] ?? 1)));
        return `<h${level}>${inner}</h${level}>${kids}`;
      }
      case 'bulleted_list_item':
        return `<ul><li>${inner}${kids}</li></ul>`;
      case 'numbered_list_item':
        return `<ol><li>${inner}${kids}</li></ol>`;
      case 'to_do':
        return `<ul><li>${b.props?.['checked'] ? '☑' : '☐'} ${inner}${kids}</li></ul>`;
      case 'quote':
      case 'callout':
        return `<blockquote>${inner}${kids}</blockquote>`;
      case 'code':
        return `<pre><code>${escapeHtml((b.text ?? []).map((r) => r.text).join(''))}</code></pre>`;
      case 'divider':
        return '<hr>';
      case 'image':
        return `<img src="${escapeHtml(String(b.props?.['src'] ?? ''))}">`;
      default:
        return `<p>${inner}</p>${kids}`;
    }
  };
  return blocks.map(one).join('');
}

function encodeSlice(slice: Slice): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(slice))));
}

function decodeSlice(data: string): Slice | null {
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Slice;
  } catch {
    return null;
  }
}

// --- paste: foreign HTML through the schema (never innerHTML) ---

const INLINE_MARK_BY_TAG: Record<string, Mark> = {
  strong: { type: 'bold' },
  b: { type: 'bold' },
  em: { type: 'italic' },
  i: { type: 'italic' },
  u: { type: 'underline' },
  s: { type: 'strike' },
  strike: { type: 'strike' },
  del: { type: 'strike' },
  code: { type: 'code' },
};

function collectRuns(node: Node, marks: Mark[], out: Run[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\n/g, ' '); // WebKit copies spaces as nbsp
    if (text) out.push({ text, marks: marks.length ? [...marks] : undefined });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') {
    out.push({ text: '\n' });
    return;
  }
  let next = marks;
  // Google Docs wraps everything in <b id="docs-internal-guid-..."> — NOT bold
  const isDocsWrapper = tag === 'b' && el.id.startsWith('docs-internal-guid');
  const mark = isDocsWrapper ? undefined : INLINE_MARK_BY_TAG[tag];
  if (mark) next = [...marks, mark];
  if (tag === 'a' && el.getAttribute('href')) {
    next = [...next, { type: 'link', attrs: { href: el.getAttribute('href')! } }];
  }
  // inline style bold/italic (Word, Google Docs spans)
  const style = el.getAttribute('style') ?? '';
  if (/font-weight:\s*(bold|[6-9]00)/.test(style)) next = [...next, { type: 'bold' }];
  if (/font-style:\s*italic/.test(style)) next = [...next, { type: 'italic' }];
  for (const child of el.childNodes) collectRuns(child, next, out);
}

function elementToBlocks(el: Element): BlockJSON[] {
  const tag = el.tagName.toLowerCase();
  const block = (type: string, props?: Record<string, unknown>, text?: Run[], children?: BlockJSON[]): BlockJSON => ({
    id: uuidv7(),
    type,
    version: 1,
    ...(props && Object.keys(props).length ? { props } : {}),
    text: text ?? [],
    ...(children?.length ? { children } : {}),
  });
  const inline = (): Run[] => {
    const runs: Run[] = [];
    collectRuns(el, [], runs);
    return runs;
  };

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return [block('heading', { level: Math.min(3, Number(tag[1])) }, inline())];
    case 'ul':
    case 'ol': {
      const out: BlockJSON[] = [];
      for (const li of el.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const runs: Run[] = [];
        const nested: BlockJSON[] = [];
        for (const child of li.childNodes) {
          const childTag = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName.toLowerCase() : '';
          if (childTag === 'ul' || childTag === 'ol') nested.push(...elementToBlocks(child as Element));
          else collectRuns(child, [], runs);
        }
        out.push(block(tag === 'ul' ? 'bulleted_list_item' : 'numbered_list_item', undefined, runs, nested));
      }
      return out;
    }
    case 'blockquote':
      return [block('quote', undefined, inline())];
    case 'pre':
      return [block('code', { language: 'plain' }, [{ text: el.textContent ?? '' }])];
    case 'hr':
      return [block('divider')];
    case 'img':
      return [block('image', { src: el.getAttribute('src') ?? '' })];
    case 'table': {
      // ponytail: tables flatten to one paragraph per row — real table block is AQ#3
      const rows: BlockJSON[] = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td,th')].map((c) => c.textContent?.trim() ?? '');
        rows.push(block('paragraph', undefined, [{ text: cells.join(' — ') }]));
      }
      return rows;
    }
    default: {
      // container-ish elements: recurse if they hold block children, else paragraph
      const hasBlockChild = [...el.children].some((c) =>
        /^(p|div|h[1-6]|ul|ol|blockquote|pre|hr|img|table|section|article)$/i.test(c.tagName),
      );
      if (hasBlockChild) return [...el.children].flatMap((c) => elementToBlocks(c));
      const runs = inline();
      if (!runs.length) return [];
      return [block('paragraph', undefined, runs)];
    }
  }
}

export function htmlToBlocks(html: string): BlockJSON[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [...doc.body.children].flatMap((el) => elementToBlocks(el));
  if (out.length) return out;
  const runs: Run[] = [];
  collectRuns(doc.body, [], runs);
  return runs.length ? [{ id: uuidv7(), type: 'paragraph', version: 1, text: runs }] : [];
}

function withFreshIds(b: BlockJSON): BlockJSON {
  return { ...b, id: uuidv7(), children: b.children?.map(withFreshIds) };
}

// --- insertion ---

function jsonToBlock(json: BlockJSON, parentId: BlockId): Block {
  return {
    id: json.id,
    type: json.type,
    version: json.version ?? 1,
    props: json.props ?? {},
    text: json.text,
    children: (json.children ?? []).map((c) => c.id),
    parentId,
  };
}

function insertBlocksAt(view: EditorView, blocks: BlockJSON[], inline: boolean): void {
  const editor = view.editor;
  const sel = editor.selection;
  const known = (t: string) => (editor.schema.has(t) ? t : 'paragraph');

  // inline paste of a single text fragment at a caret
  if (inline && blocks.length === 1 && sel?.kind === 'text' && sel.anchor.blockId === sel.head.blockId) {
    const runs = blocks[0]!.text ?? [];
    const id = sel.anchor.blockId;
    const from = Math.min(sel.anchor.offset, sel.head.offset);
    const to = Math.max(sel.anchor.offset, sel.head.offset);
    editor.dispatch(
      (tx) => {
        if (from < to) tx.op({ type: 'delete_text', id, from, to });
        if (runs.length) tx.op({ type: 'insert_text', id, offset: from, runs });
      },
      { origin: 'input', selection: textCaret(id, from + runs.reduce((n, r) => n + r.text.length, 0)) },
    );
    return;
  }

  // block paste: after the current block (or last selected), replacing an empty paragraph
  let anchorId: BlockId | null = null;
  if (sel?.kind === 'text') anchorId = sel.anchor.blockId;
  else if (sel?.kind === 'block') {
    const ids = selectedBlocks(editor.doc, sel);
    anchorId = ids[ids.length - 1] ?? null;
  }
  if (!anchorId) return;
  const anchor = getBlock(editor.doc, anchorId);
  const parentId = anchor.parentId ?? editor.doc.rootId;
  const replaceAnchor = anchor.type === 'paragraph' && textLength(anchor.text) === 0 && !anchor.children.length;

  const fresh = blocks.map(withFreshIds);
  let lastInline: BlockId | null = null;
  editor.dispatch(
    (tx) => {
      let index = childIndex(editor.doc, anchorId!) + 1;
      const insertTree = (json: BlockJSON, pid: BlockId, idx: number) => {
        const b = jsonToBlock({ ...json, type: known(json.type) }, pid);
        tx.op({ type: 'insert_block', block: b, index: idx });
        if (editor.schema.get(b.type).inline) lastInline = b.id;
        (json.children ?? []).forEach((c, i) => insertTree(c, json.id, i));
      };
      for (const json of fresh) insertTree(json, parentId, index++);
      if (replaceAnchor) tx.op({ type: 'delete_block', id: anchorId! });
    },
    { origin: 'input' },
  );
  if (lastInline) {
    const b = editor.doc.blocks.get(lastInline);
    view.focusBlock(lastInline, textLength(b?.text));
  }
}

// --- wiring ---

export function attachClipboard(view: EditorView): () => void {
  const editor = view.editor;
  let plainPasteAt = 0;

  const writeSlice = (e: ClipboardEvent): Slice | null => {
    const slice = buildSlice(view);
    if (!slice || !e.clipboardData) return null;
    e.preventDefault();
    e.clipboardData.setData('application/x-nbe', JSON.stringify(slice));
    e.clipboardData.setData(
      'text/html',
      `<div data-nbe="${encodeSlice(slice)}">${blocksToHtml(slice.blocks)}</div>`,
    );
    e.clipboardData.setData(
      'text/plain',
      slice.inline ? runsToMarkdown(slice.blocks[0]!.text) : blocksToMarkdown(slice.blocks),
    );
    return slice;
  };

  const onCopy = (e: ClipboardEvent) => {
    writeSlice(e);
  };

  const onCut = (e: ClipboardEvent) => {
    const slice = writeSlice(e);
    if (!slice) return;
    const sel = editor.selection;
    if (sel?.kind === 'block') {
      deleteBlocks(editor, selectedBlocks(editor.doc, sel));
    } else if (sel?.kind === 'text' && sel.anchor.blockId === sel.head.blockId) {
      const from = Math.min(sel.anchor.offset, sel.head.offset);
      const to = Math.max(sel.anchor.offset, sel.head.offset);
      if (from < to)
        editor.dispatch((tx) => tx.op({ type: 'delete_text', id: sel.anchor.blockId, from, to }), {
          origin: 'input',
          selection: textCaret(sel.anchor.blockId, from),
        });
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data) return;
    // only handle pastes aimed at the editor (leaves or block selection)
    if (!leafOf(e.target as Node) && editor.selection?.kind !== 'block') return;
    e.preventDefault();

    const plainRequested = Date.now() - plainPasteAt < 600;
    const plain = data.getData('text/plain');
    if (plainRequested) {
      if (!plain) return;
      const blocks: BlockJSON[] = plain
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => ({ id: uuidv7(), type: 'paragraph' as const, version: 1, text: line ? [{ text: line }] : [] }));
      insertBlocksAt(view, blocks, blocks.length === 1);
      return;
    }

    const internal = data.getData('application/x-nbe');
    if (internal) {
      try {
        const slice = JSON.parse(internal) as Slice;
        insertBlocksAt(view, slice.blocks, slice.inline);
        return;
      } catch {
        /* fall through */
      }
    }
    const html = data.getData('text/html');
    if (html) {
      const embedded = /data-nbe="([^"]+)"/.exec(html);
      const slice = embedded ? decodeSlice(embedded[1]!) : null;
      if (slice) {
        insertBlocksAt(view, slice.blocks, slice.inline);
        return;
      }
      const blocks = htmlToBlocks(html);
      if (blocks.length) {
        insertBlocksAt(view, blocks, blocks.length === 1 && blocks[0]!.type === 'paragraph');
        return;
      }
    }
    const md = data.getData('text/markdown') || plain;
    if (md) {
      const blocks = markdownToBlocks(md.replace(/\r/g, ''));
      if (blocks.length) insertBlocksAt(view, blocks, blocks.length === 1 && blocks[0]!.type === 'paragraph');
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') plainPasteAt = Date.now();
  };

  view.content.addEventListener('copy', onCopy);
  view.content.addEventListener('cut', onCut);
  view.content.addEventListener('paste', onPaste);
  view.content.addEventListener('keydown', onKeyDown);
  return () => {
    view.content.removeEventListener('copy', onCopy);
    view.content.removeEventListener('cut', onCut);
    view.content.removeEventListener('paste', onPaste);
    view.content.removeEventListener('keydown', onKeyDown);
  };
}
