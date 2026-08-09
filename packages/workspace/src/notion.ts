import { markdownToBlocks, type MarkdownOptions } from '@nbe/markdown';
import { enhancedToBlocks, isEnhancedMarkdown } from './enhanced';
import { uuidv7, type BlockJSON } from '@nbe/core';
import { SUB_PAGE } from './index';
import { collectionFromRows, type ImportedCollection } from './collection';
import { parseCsv } from './csv';
import type { VaultFile } from './vault';

/**
 * Reading a Notion Markdown export.
 *
 * @remarks
 * The reason this exists is stated in `docs/research/notion-editor.md`:
 * Notion's own Markdown export is lossy in documented ways, and users
 * experience that as lock-in — "exactly the thing our storage-readable-
 * without-the-tool principle targets". An importer that gets people *out* is
 * the other half of a promise we only otherwise make about our own files.
 *
 * **What a Notion export looks like**, from the same research note:
 *
 * - Every file is `Title <32 hex characters>.md`; the hex is the page's
 *   Notion id. Sub-pages live in a folder named the same way.
 * - The body repeats the title as a level-1 heading — which is also how our
 *   own pages are built, so it is kept rather than deduplicated.
 * - Links between pages are relative, URL-encoded file paths.
 * - Callouts come out as a blockquote led by an emoji.
 * - Databases are separate `.csv` files linked from the page.
 * - Toggles and columns are flattened; that loss is Notion's, not ours, and
 *   nothing here can undo it.
 *
 * **What this importer preserves that Notion's format nearly loses:** the page
 * *identity*. The hex in the filename becomes the page id, so a re-import
 * after an edit lands on the same pages instead of duplicating the workspace,
 * and links resolve to ids rather than to titles that may change.
 *
 * **Honest limit.** These rules come from the documented shape of the export,
 * and the fixtures in `test/notion.test.ts` are constructed from that
 * description — not captured from a real export, which needs a Notion account
 * this project does not have. The parsing is exercised; the *shape* is
 * second-hand until someone runs a real export through it. That is recorded in
 * `docs/TESTING.md` rather than glossed over.
 *
 * @category Storage
 */

/** What an import yields: pages, and the collections §2.5 keeps beside them. */
export interface NotionImport {
  /** Page documents, including one per database row. */
  pages: BlockJSON[];
  collections: ImportedCollection[];
}

/** `Title 1a2b3c…` → the title and the 32-hex id Notion appended. */
const NOTION_NAME = /^(.*?)[\s-]+([0-9a-f]{32})$/i;

interface Entry {
  path: string;
  directory: string;
  /** File name with no extension. */
  stem: string;
  title: string;
  id: string;
  text: string;
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
}

/** Notion's ids are unhyphenated UUIDs; restore the shape ours use. */
function hyphenate(hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function parseName(stem: string): { title: string; id: string } {
  const match = NOTION_NAME.exec(stem);
  if (!match) return { title: stem, id: uuidv7() };
  return { title: match[1]!.trim() || stem, id: hyphenate(match[2]!.toLowerCase()) };
}

/**
 * A blockquote led by an emoji is a callout.
 *
 * @remarks
 * `> 💡 Attention` is what Notion writes for one, and reading it back as a
 * blockquote loses the block type for the sake of two characters. The emoji is
 * detected by Unicode property rather than by a list, so this is not an
 * inventory of the emoji Notion happens to use.
 */
const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}️?)\s+(.*)$/u;

function promoteCallouts(blocks: BlockJSON[]): void {
  for (const block of blocks) {
    if (block.type === 'quote' && block.text?.length) {
      const first = block.text[0]!;
      const match = LEADING_EMOJI.exec(first.text);
      if (match) {
        block.type = 'callout';
        block.props = { ...block.props, icon: match[1] };
        block.text = [{ ...first, text: match[2]! }, ...block.text.slice(1)];
      }
    }
    if (block.children) promoteCallouts(block.children);
  }
}

/**
 * Import a Notion Markdown export.
 *
 * @param files - Every file from the unzipped export, `.md` and `.csv` alike.
 * @returns The page documents, and the collections read from the CSVs. Rows
 * are pages too and are included in `pages`, since that is what §2.5 says
 * they are.
 */
export function importNotion(files: VaultFile[], opts: MarkdownOptions = {}): NotionImport {
  const entries: Entry[] = [];
  for (const file of files) {
    if (!/\.(md|csv)$/i.test(file.path)) continue;
    const directory = directoryOf(file.path);
    const stem = file.path.slice(directory.length).replace(/\.(md|csv)$/i, '');
    const { title, id } = parseName(stem);
    if (typeof file.text !== 'string') continue; // a binary asset, not a page
    entries.push({ path: file.path, directory, stem, title, id, text: file.text });
  }

  const markdown = entries.filter((e) => /\.md$/i.test(e.path));
  const csv = entries.filter((e) => /\.csv$/i.test(e.path));

  /** Resolve a relative link target to the page it names. */
  const byPath = new Map<string, Entry>();
  for (const entry of entries) byPath.set(entry.path, entry);

  const resolveLink = (from: Entry, href: string): Entry | null => {
    let target = href;
    try {
      target = decodeURIComponent(href);
    } catch {
      /* a malformed escape: match it literally */
    }
    if (/^[a-z]+:/i.test(target)) return null; // http:, mailto: — not a page
    // relative to the linking file's own directory
    const joined = target.startsWith('/') ? target.slice(1) : from.directory + target;
    return byPath.get(joined) ?? byPath.get(target) ?? null;
  };

  const collections: ImportedCollection[] = [];
  const pages = markdown.map((entry) => {
    /*
     * Notion repeats the title as a level-1 heading, and so does every page
     * `newPage()` creates — so it is kept. Stripping it looked like removing a
     * duplicate and was measured to remove the *title*: a page's display name
     * comes from its first line of content, so the import silently renamed
     * every page after its first paragraph.
     */
    // an export may be plain Markdown or Notion's enhanced flavour; the body
    // says which, so nobody has to choose an import mode they cannot see
    const blocks = isEnhancedMarkdown(entry.text)
      ? enhancedToBlocks(entry.text)
      : markdownToBlocks(entry.text, opts);
    promoteCallouts(blocks);

    const folder = `${entry.directory}${entry.stem}/`;
    /*
     * Notion links are relative file paths, so they become link_to_page here
     * rather than staying URLs — and a link into this page's own folder is a
     * sub-page, the same rule the vault importer uses.
     */
    const relink = (block: BlockJSON): void => {
      for (const run of block.text ?? []) {
        for (const mark of run.marks ?? []) {
          if (mark.type !== 'link') continue;
          const target = resolveLink(entry, String(mark.attrs?.['href'] ?? ''));
          if (!target) continue;
          mark.type = 'mention';
          mark.attrs = { pageId: target.id };
        }
      }
      for (const child of block.children ?? []) relink(child);
    };
    for (const block of blocks) relink(block);

    // a child page's file lives in this page's folder; so does its database
    for (const child of entries) {
      if (child.directory !== folder || child === entry) continue;
      if (/\.csv$/i.test(child.path)) continue;
      if (blocks.some((b) => b.type === SUB_PAGE && b.props?.['pageId'] === child.id)) continue;
      blocks.push({
        id: uuidv7(),
        type: SUB_PAGE,
        version: 1,
        props: { pageId: child.id, title: child.title },
      });
    }
    /*
     * A database is four records (§2.5), not a table: its schema and view are
     * host records, its rows are pages, and the page only holds a view block
     * pointing at them. A flat table would have been less code and a worse
     * import — filters, sorts and typed values all die with it.
     */
    for (const table of csv.filter((c) => c.directory === folder)) {
      const imported = collectionFromRows(table.title, parseCsv(table.text));
      if (!imported) continue;
      collections.push(imported);
      blocks.push(imported.viewBlock);
    }

    return {
      id: entry.id,
      type: 'page',
      version: 1,
      props: { title: entry.title },
      children: blocks,
    } satisfies BlockJSON;
  });

  return { pages: [...pages, ...collections.flatMap((c) => c.rows)], collections };
}
