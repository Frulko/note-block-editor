import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { plainText, type BlockJSON } from '@nbe/core';
import { SUB_PAGE, pageTitle, type Workspace } from '@nbe/workspace';

/**
 * L2, the derived index — SQLite, for a runtime that has a filesystem.
 *
 * @remarks
 * §10, as corrected on 2026-08-07: the index's *implementation depends on the
 * runtime*. In a browser it is whatever the browser provides. Here, where the
 * workspace is real files, it is SQLite — WAL so a reader never blocks the
 * writer, FTS5 so search is ranked rather than a linear scan, and a links
 * table so backlinks are a query rather than a walk of every document.
 *
 * No dependency: Node ships SQLite, with FTS5 compiled in (checked, not
 * assumed). That is the whole reason this is reasonable at all — the browser
 * path explicitly refuses SQLite because it would mean shipping a WASM binary
 * to rebuild something the platform already stores.
 *
 * **It holds zero unique information.** Delete the file and rebuild, and every
 * answer is identical; `test/index-db.test.ts` asserts precisely that, because
 * an index that quietly becomes authoritative is how a "cache" turns into a
 * second source of truth nobody can migrate.
 *
 * @category Storage
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id     TEXT PRIMARY KEY,
  title  TEXT NOT NULL,
  parent TEXT
);
CREATE TABLE IF NOT EXISTS links (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_target ON links(target);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, title, body);
`;

export interface IndexHit {
  pageId: string;
  title: string;
  snippet: string;
}

export interface IndexBacklink {
  pageId: string;
  title: string;
  kind: string;
}

/** Every block in a document, parents before children. */
function* walk(block: BlockJSON): Generator<BlockJSON> {
  yield block;
  for (const child of block.children ?? []) yield* walk(child);
}

/** The page ids a document points at, and how. */
function referencesOf(page: BlockJSON): Array<{ target: string; kind: string }> {
  const out: Array<{ target: string; kind: string }> = [];
  for (const block of walk(page)) {
    const target = String(block.props?.['pageId'] ?? '');
    if (target && block.type === SUB_PAGE) out.push({ target, kind: 'sub_page' });
    else if (target && block.type === 'link_to_page') out.push({ target, kind: 'link_to_page' });
    for (const run of block.text ?? []) {
      for (const mark of run.marks ?? []) {
        const id = String(mark.attrs?.['pageId'] ?? '');
        if (mark.type === 'mention' && id) out.push({ target: id, kind: 'mention' });
      }
    }
  }
  return out;
}

export class WorkspaceIndex {
  private readonly db: DatabaseSync;

  constructor(root: string) {
    this.db = new DatabaseSync(join(root, '.nbe', 'index.sqlite'));
    // WAL: a `nbe search` running while `nbe watch` writes must not block
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(SCHEMA);
  }

  /**
   * Rebuild from the documents.
   *
   * @remarks
   * A full scan, not an incremental update. Incremental is what makes an index
   * drift from its source, and the whole claim here is that it cannot: a
   * person's workspace rebuilds in milliseconds, and when it stops doing so
   * the fix is to make the rebuild cheaper, not to make it partial.
   */
  rebuild(workspace: Workspace): number {
    const documents = workspace.pages
      .map((node) => workspace.document(node.id))
      .filter((doc): doc is BlockJSON => doc !== null);

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM pages');
      this.db.exec('DELETE FROM links');
      this.db.exec('DELETE FROM search');
      const page = this.db.prepare('INSERT INTO pages (id, title, parent) VALUES (?, ?, ?)');
      const link = this.db.prepare('INSERT INTO links (source, target, kind) VALUES (?, ?, ?)');
      const text = this.db.prepare('INSERT INTO search (id, title, body) VALUES (?, ?, ?)');

      for (const doc of documents) {
        const node = workspace.node(doc.id);
        const title = node?.title ?? pageTitle(doc);
        page.run(doc.id, title, node?.parentId ?? null);
        const body = [...walk(doc)].map((b) => plainText(b.text)).filter(Boolean).join('\n');
        text.run(doc.id, title, body);
        for (const reference of referencesOf(doc)) link.run(doc.id, reference.target, reference.kind);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return documents.length;
  }

  /** Ranked full-text search, with the matching text highlighted by `…`. */
  search(query: string, limit = 20): IndexHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const rows = this.db
      .prepare(
        `SELECT id, title, snippet(search, 2, '', '', '…', 12) AS snippet
         FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(escapeMatch(trimmed), limit) as Array<{ id: string; title: string; snippet: string }>;
    return rows.map((row) => ({ pageId: row.id, title: row.title, snippet: row.snippet }));
  }

  /** Pages that point at `id`, one row per reference kind. */
  backlinks(id: string): IndexBacklink[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT links.source AS id, pages.title AS title, links.kind AS kind
         FROM links JOIN pages ON pages.id = links.source
         WHERE links.target = ? AND links.source <> ?`,
      )
      .all(id, id) as Array<{ id: string; title: string; kind: string }>;
    return rows.map((row) => ({ pageId: row.id, title: row.title, kind: row.kind }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Quote a user's words for FTS5.
 *
 * @remarks
 * FTS5's MATCH takes a query language, so an apostrophe or a bare `-` from
 * someone searching for "aujourd'hui" or "vis-à-vis" is a syntax error rather
 * than a search. Each word becomes a quoted phrase, which is what a person
 * typing words into a box means.
 */
function escapeMatch(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(' ');
}
