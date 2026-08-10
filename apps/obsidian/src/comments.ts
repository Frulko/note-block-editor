import {
  memoryComments,
  type BlockId,
  type BlockJSON,
  type CommentStore,
  type CommentThread,
  type Editor,
  type Run,
} from '@nbe/core';
import { fr, openCommentThread, type CommentAuthor, type CommentContext } from '@nbe/dom';
import type { Frontmatter } from '@nbe/markdown';

/**
 * Comments in a vault, kept in the note itself.
 *
 * @remarks
 * The plugin's own doc used to say "no comments", and the reason was real: in
 * a vault **the Markdown *is* the document**, so a thread has nowhere else to
 * live. A sidecar file would work and is what most plugins do — and it is
 * exactly what this project refuses elsewhere, because a note carried to
 * another machine on a USB stick would arrive with its discussion left behind.
 *
 * So the note carries it, in two halves:
 *
 * - the **anchor** is `%%^<id>%%` at the end of the commented block's line,
 *   Obsidian's own comment syntax, which reading mode renders as nothing. It
 *   travels with the block through a reorder, a rename or an edit made in
 *   another editor, which is what an index into the file cannot do.
 * - the **threads** are the `comments` section of the note's YAML frontmatter
 *   ({@link @nbe/markdown!Frontmatter}), where a document's metadata belongs
 *   and where no reader mistakes it for prose.
 *
 * They used to be a `%%carnet-comments … %%` block at the *end* of the note —
 * invisible when rendered, but text all the same: it moved when the note was
 * appended to, Obsidian's word count counted it, a search matched inside it,
 * and a `%%` typed by hand could swallow it. The frontmatter is the place every
 * other tool already agrees is not prose. Notes written the old way are still
 * read ({@link legacyThreads}) and move over on the next save.
 *
 * @module
 */

/** `%%^abc123%%` — the anchor, at the end of a block's text. */
const ANCHOR = /\s*%%\^([A-Za-z0-9_-]+)%%/g;

/** The frontmatter section the discussion lives in: `nbe.comments`. */
export const COMMENTS_SECTION = 'comments';

const OPEN = '%%carnet-comments';
const CLOSE = '%%';

export interface NoteComments {
  markdown: string;
  threads: CommentThread[];
}

/** Anything that is not a thread, out — the file is text, and text is edited. */
function threadsOf(value: unknown): CommentThread[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is CommentThread => !!t && typeof t.id === 'string' && Array.isArray(t.messages));
}

/**
 * The threads a note carries, and the prose with nothing extra left in it.
 *
 * @param frontmatter - The note's header, already split off by `readFrontmatter`.
 * @param markdown - The body under it.
 */
export function readComments(frontmatter: Frontmatter, markdown: string): NoteComments {
  const own = threadsOf(frontmatter.section(COMMENTS_SECTION));
  if (own.length) return { markdown, threads: own };
  return legacyThreads(markdown);
}

/**
 * A note written before the threads moved to the frontmatter.
 *
 * @remarks
 * A malformed block is *kept as text* rather than dropped: a thread nobody can
 * parse is still something someone wrote, and silently deleting it on the next
 * save is the one outcome worse than showing it.
 */
export function legacyThreads(markdown: string): NoteComments {
  const start = markdown.lastIndexOf(`\n${OPEN}`);
  if (start === -1) return { markdown, threads: [] };
  const body = markdown.slice(start + OPEN.length + 1);
  const end = body.indexOf(`\n${CLOSE}`);
  if (end === -1) return { markdown, threads: [] };
  const threads: CommentThread[] = [];
  for (const line of body.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try {
      const thread = JSON.parse(line) as CommentThread;
      if (thread?.id && Array.isArray(thread.messages)) threads.push(thread);
    } catch {
      return { markdown, threads: [] }; // unreadable: leave the note alone
    }
  }
  return { markdown: markdown.slice(0, start), threads };
}

/**
 * Put the threads back into the note's header, or take the section away.
 *
 * @remarks
 * Removing it when there is nothing to say is what keeps a note that was never
 * commented on identical to one this plugin has never opened.
 */
export function writeComments(frontmatter: Frontmatter, threads: readonly CommentThread[]): void {
  frontmatter.setSection(COMMENTS_SECTION, threads.length ? threads : undefined);
}

/**
 * Strip the anchors from parsed blocks, turning each into a `comment` mark.
 *
 * @param known - The threads the note actually carries. An anchor naming
 * anything else is dropped rather than turned into a mark: the margin counts
 * marks, so a `%%^id%%` left behind by a hand-edited `%%carnet-comments%%`
 * block gave the paragraph a badge that opened an empty panel — and there is
 * no way to get rid of it from the editor, because there is no thread to
 * delete. The anchor text still leaves the document, which is the point.
 */
export function applyAnchors(blocks: BlockJSON[], known?: ReadonlySet<string>): BlockJSON[] {
  const walk = (list: BlockJSON[]): BlockJSON[] =>
    list.map((block) => {
      const runs = block.text ?? [];
      const ids = new Set<string>();
      const text: Run[] = runs.map((run) => {
        const cleaned = run.text.replace(ANCHOR, (_, id: string) => {
          ids.add(id);
          return '';
        });
        return cleaned === run.text ? run : { ...run, text: cleaned };
      });
      const kept = text.filter((run) => run.text.length > 0);
      const live = [...ids].filter((id) => !known || known.has(id));
      const marks = live.map((id) => ({ type: 'comment', attrs: { threadId: id } }));
      return {
        ...block,
        // the anchors always come out of the text; only a *live* one becomes a
        // mark, so a stale `%%^id%%` disappears from the note on the next save
        ...(ids.size
          ? { text: marks.length ? kept.map((run) => ({ ...run, marks: [...(run.marks ?? []), ...marks] })) : kept }
          : { text: runs }),
        ...(block.children?.length ? { children: walk(block.children) } : {}),
      };
    });
  return walk(blocks);
}

/** The distinct threads anchored on a block's text. */
function threadIdsOf(block: BlockJSON): string[] {
  const ids = new Set<string>();
  for (const run of block.text ?? []) {
    for (const mark of run.marks ?? []) {
      if (mark.type === 'comment' && typeof mark.attrs?.['threadId'] === 'string') {
        ids.add(mark.attrs['threadId'] as string);
      }
    }
  }
  return [...ids];
}

/**
 * Put the anchors back into the blocks, before they are serialised.
 *
 * @remarks
 * A plain text run appended to the block, so `blocksToMarkdown` writes it
 * without needing to know what a comment is — the alternative was teaching the
 * Markdown package a syntax only one host uses.
 */
export function restoreAnchors(blocks: BlockJSON[]): BlockJSON[] {
  const walk = (list: BlockJSON[]): BlockJSON[] =>
    list.map((block) => {
      const ids = threadIdsOf(block);
      const marker = ids.map((id) => ` %%^${id}%%`).join('');
      return {
        ...block,
        ...(marker ? { text: [...(block.text ?? []), { text: marker }] } : {}),
        ...(block.children?.length ? { children: walk(block.children) } : {}),
      };
    });
  return walk(blocks);
}

export interface NoteCommentHost {
  store: CommentStore;
  /** Wire to `EditorViewOptions.onComment`. */
  onComment: (editor: Editor, blockId: BlockId, author: CommentAuthor | null, at?: CommentContext) => void;
}

/**
 * @param initial - Threads read out of the note.
 * @param onChange - Called after every change, so the view can mark the file dirty.
 *
 * @remarks
 * The bubble is `openCommentThread` from `@nbe/dom`. This file used to build
 * its own, and could only ever ask for one more message: the discussion so far
 * was crammed into the textarea's *placeholder*, where it could not be
 * scrolled, selected, or deleted. Nothing about a vault made that necessary —
 * it was the editor lacking the part, and it has it now.
 */
export function createNoteComments(initial: CommentThread[], onChange: () => void): NoteCommentHost {
  const store = memoryComments(initial);
  store.onChange(onChange);

  /*
   * `at` is which affordance asked: nothing for the gutter (the whole block),
   * a `range` from the format toolbar, a `threadId` from a click on a
   * highlight. The anchor syntax in the note does not change — `%%^id%%` still
   * rides at the end of the block's line — because a comment's *anchor* is the
   * block it travels with; the offsets are what the highlight is drawn over,
   * and those are re-derived from the marks on every open.
   */
  const onComment = (
    editor: Editor,
    blockId: BlockId,
    author: CommentAuthor | null,
    at?: CommentContext,
  ): void => {
    openCommentThread({ editor, store, blockId, author, labels: fr, locale: 'fr', ...at });
  };

  return { store, onComment };
}
