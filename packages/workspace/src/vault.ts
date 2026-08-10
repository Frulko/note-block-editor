import {
  Frontmatter,
  blocksToMarkdown,
  markdownToBlocks,
  readFrontmatter,
  slugify,
  writeFrontmatter,
  type MarkdownOptions,
} from '@nbe/markdown';
import { uuidv7, type BlockJSON } from '@nbe/core';
import { SUB_PAGE, pageTitle } from './index';
import type { Workspace } from './index';

/**
 * A workspace as a folder of Markdown — L1, the human projection (§10).
 *
 * @remarks
 * The promise this keeps is the project's first one: **delete the app and the
 * workspace is still readable**. Not exported, not converted — readable, in a
 * text editor, with the hierarchy visible as folders.
 *
 * It produces an *artifact*: a list of paths and contents. No File System
 * Access API, no directory handles, no Chromium-only anything. The caller
 * decides what that becomes — a zip to download, files on a desktop runtime
 * (ROADMAP phase 4b), a tarball on a server. That was the project owner's
 * correction on 2026-08-07 and it is what makes this shippable in every
 * browser rather than one.
 *
 * **The layout is the Obsidian convention**, because an exported workspace
 * should open as a vault rather than merely resemble one: a page is
 * `<Title>.md`, and a page with children also owns a `<Title>/` folder holding
 * them. Nesting is folders, so the tree is legible before anything parses it.
 *
 * **How the tree survives a round trip.** A sub-page and a link-to-page both
 * project to `[[wikilink]]` — Markdown has no way to say "and this one lives
 * here" (D7, a documented loss). Rather than invent syntax, import reads the
 * distinction back out of the vault itself:
 *
 * > a wikilink whose target is a file in *this page's folder* is a sub-page;
 * > any other wikilink is a link.
 *
 * That is the same inference a person reading the vault would make, it needs
 * no marker a human would have to understand, and it means hand-moving a file
 * between folders in Obsidian re-parents the page — which is the point of
 * file-over-app.
 *
 * Ids ride in YAML frontmatter (D7: "IDs preserved"), so a round trip through
 * a text editor keeps every block anchor, backlink and deep link intact.
 *
 * @category Storage
 */

export interface VaultFile {
  /** Path relative to the vault root, using `/` on every platform. */
  path: string;
  /** Text content. Exactly one of `text` and `bytes` is set. */
  text?: string;
  /** Binary content, for the assets a page refers to. */
  bytes?: Uint8Array;
}

/** Where binary content goes, so a reader finds it beside the prose. */
export const ASSETS_DIRECTORY = 'assets';

export interface ExportOptions {
  /**
   * The bytes behind each `asset:<hash>` reference.
   *
   * @remarks
   * Supplied by the caller because this package holds no blobs and should not:
   * where binaries live is the runtime's business — IndexedDB in a browser,
   * files on a backend. Refs with no entry are left alone rather than dropped,
   * so a partial asset store degrades to a missing image instead of losing the
   * block that held it.
   */
  assets?: ReadonlyMap<string, Uint8Array>;
  /**
   * Block plugins whose markdown projection the export should use.
   *
   * @remarks
   * A vault is only "still readable when the app is gone" if every block that
   * has a markdown form gets to write it. Without the plugins a table exports
   * as a marker comment — visible, but not a table — so a host that registers
   * blocks in its editor must register them here too. Import takes the same
   * option, and the pair is what keeps the round trip stable.
   */
  plugins?: MarkdownOptions['plugins'];
}

/**
 * The header of a page file: the id that makes the round trip lossless, and
 * the title the filename had to reduce.
 *
 * @remarks
 * `@nbe/markdown` owns the format now — this file used to hand-roll both
 * directions, which is a second YAML dialect to keep in step with the first for
 * no gain. What a vault's own frontmatter holds (`tags`, `aliases`,
 * `cssclasses`) is read as a map rather than grepped for two lines; a workspace
 * has nowhere to *keep* those keys yet, so import still leaves them behind —
 * but it no longer does so because the reader cannot see them.
 */
function header(id: string, title: string): Frontmatter {
  return new Frontmatter().set('id', id).set('title', title);
}

/**
 * Project a workspace to Markdown files.
 *
 * @param workspace - A loaded {@link Workspace}.
 * @returns One file per page, parents before children.
 */
export function exportVault(workspace: Workspace, opts: ExportOptions = {}): VaultFile[] {
  const files: VaultFile[] = [];
  const used = new Set<string>();

  /*
   * `asset:<hash>` is opaque and means nothing outside the app, so a vault
   * that kept it would have dangling images — the one thing "readable without
   * the tool" cannot afford. Rewrite each ref to a path *relative to the page
   * that holds it*, so the vault stays self-contained however it is moved.
   */
  const rewriteAssets = (value: unknown, upwards: string): unknown => {
    if (typeof value === 'string') {
      if (!value.startsWith('asset:')) return value;
      const hash = value.slice('asset:'.length);
      if (!opts.assets?.has(value)) return value;
      used.add(value);
      return `${upwards}${ASSETS_DIRECTORY}/${hash}`;
    }
    if (Array.isArray(value)) return value.map((item) => rewriteAssets(item, upwards));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewriteAssets(item, upwards)]),
      );
    }
    return value;
  };

  const prepare = (block: BlockJSON, upwards: string): BlockJSON => ({
    ...block,
    ...(block.props ? { props: rewriteAssets(block.props, upwards) as Record<string, unknown> } : {}),
    ...(block.children ? { children: block.children.map((child) => prepare(child, upwards)) } : {}),
  });

  const emit = (pageId: string, directory: string, depth: number): void => {
    const node = workspace.node(pageId);
    const doc = workspace.document(pageId);
    if (!node || !doc) return;
    const slug = slugify(node.title);
    const upwards = '../'.repeat(depth);
    files.push({
      path: `${directory}${slug}.md`,
      // the blank line between the header and the prose is the body's, not the
      // frontmatter's: a note that arrives without one must not grow one
      text: writeFrontmatter(
        header(pageId, node.title),
        '\n' +
          blocksToMarkdown((doc.children ?? []).map((block) => prepare(block, upwards)), {
            plugins: opts.plugins,
          }),
      ),
    });
    // children live in a folder named after their parent, so the hierarchy is
    // the folder tree — what a vault reader already understands
    for (const child of node.children) emit(child, `${directory}${slug}/`, depth + 1);
  };

  for (const root of workspace.roots) emit(root, '', 0);

  for (const ref of used) {
    const bytes = opts.assets!.get(ref)!;
    files.push({ path: `${ASSETS_DIRECTORY}/${ref.slice('asset:'.length)}`, bytes });
  }
  return files;
}

/** The folder a path lives in, with its trailing slash, or `''` at the root. */
function directoryOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
}

/** The file name without `.md`. */
function stemOf(path: string): string {
  return path.slice(directoryOf(path).length).replace(/\.md$/i, '');
}

/**
 * Read a vault back into pages.
 *
 * @remarks
 * The inverse of {@link exportVault}, and deliberately tolerant of a vault a
 * *person* edited: a file with no frontmatter gets a fresh id, a wikilink
 * pointing nowhere stays an ordinary link, and a folder with no matching page
 * file is simply a folder. Anything stricter would punish the very editing
 * this format exists to allow.
 *
 * @returns Page documents, each carrying `sub_page` blocks for its children —
 * ready to hand to a `WorkspaceStorage` one at a time.
 */
export function importVault(files: VaultFile[], opts: MarkdownOptions = {}): BlockJSON[] {
  const markdown = files.filter((f) => /\.md$/i.test(f.path) && typeof f.text === 'string');

  // pass 1: give every file an identity, so links can be resolved in pass 2
  const parsed = markdown.map((file) => {
    const { frontmatter, body: p_body } = readFrontmatter(file.text!);
    const stem = stemOf(file.path);
    return {
      path: file.path,
      id: String(frontmatter.get('id') ?? '') || uuidv7(),
      title: String(frontmatter.get('title') ?? '') || stem,
      stem,
      directory: directoryOf(file.path),
      body: p_body,
    };
  });

  /** A page's own folder: where its children live. */
  const folderOf = (p: (typeof parsed)[number]) => `${p.directory}${p.stem}/`;
  const byFolderAndTitle = new Map<string, string>();
  for (const p of parsed) byFolderAndTitle.set(`${p.directory} ${p.title}`, p.id);

  return parsed.map((p) => {
    const blocks = markdownToBlocks(p.body, opts);
    const folder = folderOf(p);
    /*
     * A wikilink became a `link_to_page` on parse. Promote it to a `sub_page`
     * when its target is a file inside this page's folder — the rule stated in
     * this module's remarks, and the only thing that rebuilds the tree.
     */
    const promote = (block: BlockJSON): void => {
      if (block.type === 'link_to_page') {
        const title = String(block.props?.['title'] ?? '');
        const childId = byFolderAndTitle.get(`${folder} ${title}`);
        if (childId) {
          block.type = SUB_PAGE;
          block.props = { ...block.props, pageId: childId };
        }
      }
      for (const child of block.children ?? []) promote(child);
    };
    for (const block of blocks) promote(block);

    /*
     * `assets/<hash>` goes back to `asset:<hash>`. Any number of `../` may
     * precede it, since the path was written relative to the page's depth.
     */
    const restoreAssets = (block: BlockJSON): void => {
      if (block.props) {
        for (const [key, value] of Object.entries(block.props)) {
          if (typeof value !== 'string') continue;
          const match = new RegExp(`^(?:\\.\\./)*${ASSETS_DIRECTORY}/([0-9a-f]+)$`).exec(value);
          if (match) block.props[key] = `asset:${match[1]}`;
        }
      }
      for (const child of block.children ?? []) restoreAssets(child);
    };
    for (const block of blocks) restoreAssets(block);

    return {
      id: p.id,
      type: 'page',
      version: 1,
      props: { title: p.title },
      children: blocks,
    } satisfies BlockJSON;
  });
}

/** A page's title as {@link exportVault} would name its file. */
export function vaultPathFor(workspace: Workspace, pageId: string): string | null {
  const path = workspace.path(pageId);
  if (!path.length) return null;
  return path.map((node) => slugify(node.title)).join('/') + '.md';
}

/** Re-exported so a caller can name a page without loading a workspace. */
export { pageTitle, slugify };
