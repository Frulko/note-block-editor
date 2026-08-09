import { describe, expect, it } from 'vitest';
import type { BlockJSON, CommentThread } from '../packages/core/src/index';
import { applyAnchors, readComments, restoreAnchors, writeComments } from '../apps/obsidian/src/comments';

/**
 * In a vault the Markdown *is* the document, so a thread has nowhere else to
 * live — and a sidecar file is exactly what this project refuses, because a
 * note carried away on a USB stick would arrive with its discussion left
 * behind. So the note carries it, in Obsidian's own comment syntax, and these
 * are the two halves of that: the anchor in the line, the threads at the end.
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

describe('the threads at the end of the note', () => {
  it('round-trips through the note, and leaves prose alone', () => {
    const note = 'un paragraphe\n\nun autre\n';
    const written = writeComments(note, [thread('t1', 'b1')]);
    expect(written).toContain('%%carnet-comments');

    const read = readComments(written);
    expect(read.markdown.trimEnd()).toBe(note.trimEnd());
    expect(read.threads.map((t) => t.id)).toEqual(['t1']);
  });

  it('writes nothing at all when there is nothing to say', () => {
    expect(writeComments('un paragraphe\n', [])).toBe('un paragraphe\n');
    expect(readComments('un paragraphe\n').threads).toEqual([]);
  });

  it('keeps a block it cannot parse rather than deleting what someone wrote', () => {
    const note = 'un paragraphe\n\n%%carnet-comments\nceci nest pas du JSON\n%%\n';
    const read = readComments(note);
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
