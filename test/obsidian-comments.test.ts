import { describe, expect, it } from 'vitest';
import type { BlockJSON, CommentThread } from '../packages/core/src/index';
import { Frontmatter, readFrontmatter, writeFrontmatter } from '../packages/markdown/src/index';
import { applyAnchors, readComments, restoreAnchors, writeComments } from '../apps/obsidian/src/comments';

/**
 * In a vault the Markdown *is* the document, so a thread has nowhere else to
 * live — and a sidecar file is exactly what this project refuses, because a
 * note carried away on a USB stick would arrive with its discussion left
 * behind. So the note carries it, and these are the two halves of that: the
 * anchor in the line, the threads in the header.
 */
const thread = (id: string, blockId: string): CommentThread => ({
  id,
  blockId,
  resolved: false,
  messages: [{ id: `m-${id}`, author: 'a', body: 'coucou', at: 1 }],
});

const block = (text: string, id = 'b1'): BlockJSON => ({
  id,
  type: 'paragraph',
  version: 1,
  text: [{ text }],
});

/** A note as a file: the header written back over the prose. */
function fileOf(frontmatter: Frontmatter, body: string): string {
  return writeFrontmatter(frontmatter, body);
}

describe('the threads in the note header', () => {
  it('round-trips through the file, and leaves the prose alone', () => {
    const body = 'un paragraphe\n\nun autre\n';
    const fm = new Frontmatter();
    writeComments(fm, [thread('t1', 'b1')]);
    const written = fileOf(fm, body);
    expect(written).toContain('nbe: {"comments"');

    const file = readFrontmatter(written);
    const read = readComments(file.frontmatter, file.body);
    expect(read.markdown).toBe(body);
    expect(read.threads.map((t) => t.id)).toEqual(['t1']);
  });

  it('writes nothing at all when there is nothing to say', () => {
    const fm = new Frontmatter();
    writeComments(fm, []);
    expect(fileOf(fm, 'un paragraphe\n')).toBe('un paragraphe\n');
    expect(readComments(fm, 'un paragraphe\n').threads).toEqual([]);
  });

  it('leaves the rest of the header exactly where the vault put it', () => {
    const note = '---\ntags:\n  - projet\n---\n\nun paragraphe\n';
    const file = readFrontmatter(note);
    writeComments(file.frontmatter, [thread('t1', 'b1')]);
    const written = fileOf(file.frontmatter, file.body);
    expect(written).toContain('tags:\n  - projet');

    // and taking the discussion away takes every trace of it with it
    const cleared = readFrontmatter(written);
    writeComments(cleared.frontmatter, []);
    expect(fileOf(cleared.frontmatter, cleared.body)).toBe(note);
  });

  it('ignores what a hand edit made of it, rather than trusting the file', () => {
    const fm = new Frontmatter().set('nbe', { comments: ['pas un fil', { id: 'x' }] });
    expect(readComments(fm, 'un paragraphe\n').threads).toEqual([]);
  });

  it('still reads a note written the old way, and moves it over', () => {
    const legacy = 'un paragraphe\n\n%%carnet-comments\n' + JSON.stringify(thread('t1', 'b1')) + '\n%%\n';
    const read = readComments(new Frontmatter(), legacy);
    expect(read.threads.map((t) => t.id)).toEqual(['t1']);
    expect(read.markdown).toBe('un paragraphe\n');

    const fm = new Frontmatter();
    writeComments(fm, read.threads);
    expect(fileOf(fm, read.markdown)).not.toContain('%%carnet-comments');
  });

  it('keeps an old block it cannot parse rather than deleting what someone wrote', () => {
    const note = 'un paragraphe\n\n%%carnet-comments\nceci nest pas du JSON\n%%\n';
    const read = readComments(new Frontmatter(), note);
    expect(read.threads).toEqual([]);
    expect(read.markdown).toBe(note);
  });
});

describe('the anchor in the line', () => {
  it('becomes a mark on the way in, and a marker on the way out', () => {
    const parsed = applyAnchors([block('du texte %%^t1%%')]);
    expect(parsed[0]!.text!.map((r) => r.text).join('')).toBe('du texte');
    expect(parsed[0]!.text![0]!.marks).toEqual([{ type: 'comment', attrs: { threadId: 't1' } }]);

    const back = restoreAnchors(parsed);
    expect(back[0]!.text!.map((r) => r.text).join('')).toBe('du texte %%^t1%%');
  });

  it('carries several threads on one block', () => {
    const parsed = applyAnchors([block('deux fils %%^a%% %%^b%%')]);
    const ids = parsed[0]!.text![0]!.marks!.map((m) => m.attrs!['threadId']);
    expect(ids).toEqual(['a', 'b']);
    expect(restoreAnchors(parsed)[0]!.text!.map((r) => r.text).join('')).toBe('deux fils %%^a%% %%^b%%');
  });

  it('leaves a block with no anchor exactly as it was', () => {
    const blocks = [block('rien a signaler')];
    expect(applyAnchors(blocks)[0]!.text).toEqual(blocks[0]!.text);
    expect(restoreAnchors(blocks)[0]!.text).toEqual(blocks[0]!.text);
  });

  it('reaches nested blocks, because a comment on a list item is normal', () => {
    const parent: BlockJSON = { ...block('parent'), children: [block('enfant %%^t9%%', 'b2')] };
    const parsed = applyAnchors([parent]);
    expect(parsed[0]!.children![0]!.text![0]!.marks).toEqual([
      { type: 'comment', attrs: { threadId: 't9' } },
    ]);
  });
});
