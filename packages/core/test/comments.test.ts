import { describe, expect, it } from 'vitest';
import type { Run } from '../src/types';
import { Editor } from '../src/editor';
import { getBlock } from '../src/doc';
import { insertText, toggleMarkRange } from '../src/commands';
import { applyMark, marksAt } from '../src/richtext';
import { documentOrder } from '../src/doc';
import {
  anchoredThreads,
  memoryComments,
  newMessage,
  newThread,
  orphanThreads,
  threadIdsIn,
  threadsInDocumentOrder,
} from '../src/comments';
import type { Block, TextSelection } from '../src/types';

/**
 * Comments anchored to text.
 *
 * @remarks
 * The behaviour worth protecting is not "a comment can be created" — it is that
 * the anchor stays on the words it was put on while the document is edited
 * around it, and that a thread survives losing them.
 */

function seed(editor: Editor, id: string, text: string): Block {
  const pid = editor.doc.rootId;
  const block: Block = {
    id,
    type: 'paragraph',
    version: 1,
    props: {},
    text: text ? [{ text }] : [],
    children: [],
    parentId: pid,
  };
  editor.dispatch(
    (tx) => tx.op({ type: 'insert_block', block, index: getBlock(editor.doc, pid).children.length }),
    { addToHistory: false },
  );
  return getBlock(editor.doc, id);
}

const range = (a: string, ao: number, h: string, ho: number): TextSelection => ({
  kind: 'text',
  anchor: { blockId: a, offset: ao },
  head: { blockId: h, offset: ho },
});

function doc(): Editor {
  const editor = new Editor();
  seed(editor, 'a', 'premier bloc');
  seed(editor, 'b', 'deuxième bloc');
  return editor;
}

/** Comment the current selection, the way a UI would. */
function comment(editor: Editor, threadId: string): boolean {
  return toggleMarkRange(editor, 'comment', { threadId });
}

describe('a comment anchors to text, not to an offset', () => {
  it('marks exactly the selected words', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'a', 12));
    expect(comment(editor, 'fil-1')).toBe(true);

    expect(threadIdsIn(getBlock(editor.doc, 'a'))).toEqual(['fil-1']);
    expect(getBlock(editor.doc, 'a').text).toEqual([
      { text: 'premier ', marks: undefined },
      { text: 'bloc', marks: [{ type: 'comment', attrs: { threadId: 'fil-1' } }] },
    ]);
  });

  it('spans blocks, and both ends report the same thread', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'b', 8));
    comment(editor, 'fil-2');
    expect(threadIdsIn(getBlock(editor.doc, 'a'))).toEqual(['fil-2']);
    expect(threadIdsIn(getBlock(editor.doc, 'b'))).toEqual(['fil-2']);
  });

  it('does not swallow text typed against its end', () => {
    // the reason `comment` declares expand: 'none' — a thread that grows over
    // words nobody commented on is worse than one that stops too early
    const editor = doc();
    editor.setSelection(range('a', 8, 'a', 12));
    comment(editor, 'fil-3');

    // what the next character would inherit, and then the character itself
    expect((marksAt(getBlock(editor.doc, 'a').text, 12) ?? []).map((mark) => mark.type)).not.toContain('comment');

    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 12 }, head: { blockId: 'a', offset: 12 } });
    insertText(editor, ' ajouté');

    const text = getBlock(editor.doc, 'a').text!;
    const commented = text
      .filter((run) => (run.marks ?? []).some((mark) => mark.type === 'comment'))
      .map((run) => run.text)
      .join('');
    expect(commented).toBe('bloc');
  });

  it('follows its words when text is inserted before them', () => {
    const editor = doc();
    editor.setSelection(range('a', 8, 'a', 12));
    comment(editor, 'fil-4');

    editor.setSelection({ kind: 'text', anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 0 } });
    insertText(editor, 'tout ');

    const text = getBlock(editor.doc, 'a').text!;
    const commented = text.filter((run) => (run.marks ?? []).some((mark) => mark.type === 'comment'));
    expect(commented.map((run) => run.text).join('')).toBe('bloc');
  });
});

describe('threads outlive their anchors', () => {
  it('a thread whose text was deleted is an orphan, not a deletion', () => {
    const editor = doc();
    const store = memoryComments();
    editor.setSelection(range('a', 8, 'a', 12));
    const thread = newThread(newMessage('alice', 'on garde ce mot ?'), 'a');
    store.create(thread);
    comment(editor, thread.id);

    expect(orphanThreads(editor.doc, store)).toEqual([]);

    // remove the commented words, which removes the mark with them
    editor.setSelection(range('a', 8, 'a', 12));
    toggleMarkRange(editor, 'comment', { threadId: thread.id }); // off
    expect(anchoredThreads(editor.doc).has(thread.id)).toBe(false);

    const orphans = orphanThreads(editor.doc, store);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.messages[0]!.body).toBe('on garde ce mot ?');
  });

  it('a reply lands on the thread and the store reports the change', () => {
    const store = memoryComments();
    let changes = 0;
    store.onChange(() => changes++);

    const thread = newThread(newMessage('alice', 'ceci est ambigu'));
    store.create(thread);
    store.addMessage(thread.id, newMessage('bob', 'reformulé'));

    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['ceci est ambigu', 'reformulé']);
    expect(changes).toBe(2);
  });

  it('deleting one message leaves the rest of the discussion standing', () => {
    const store = memoryComments();
    const first = newMessage('alice', 'ceci est ambigu');
    const reply = newMessage('bob', 'reformulé');
    const thread = newThread(first);
    store.create(thread);
    store.addMessage(thread.id, reply);

    store.deleteMessage(thread.id, reply.id);

    expect(store.get(thread.id)!.messages.map((m) => m.body)).toEqual(['ceci est ambigu']);
  });

  it('deleting the last message deletes the thread, not an empty card', () => {
    const store = memoryComments();
    let changes = 0;
    const only = newMessage('alice', 'oublie ça');
    const thread = newThread(only);
    store.create(thread);
    store.onChange(() => changes++);

    store.deleteMessage(thread.id, only.id);

    expect(store.get(thread.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(changes).toBe(1);
    // a message that is not there is not a change, and must not wake a panel
    store.deleteMessage(thread.id, only.id);
    expect(changes).toBe(1);
  });

  it('resolving keeps the thread and its history', () => {
    const store = memoryComments();
    const thread = newThread(newMessage('alice', 'à corriger'));
    store.create(thread);
    store.setResolved(thread.id, true);
    expect(store.get(thread.id)!.resolved).toBe(true);
    expect(store.get(thread.id)!.messages).toHaveLength(1);
  });
});

describe('threads are listed the way the page reads', () => {
  it('in document order, not creation order', () => {
    const editor = doc();
    const store = memoryComments();

    // created second, but anchored in the first block
    const later = newThread(newMessage('alice', 'sur le bloc b'), 'b');
    editor.setSelection(range('b', 0, 'b', 8));
    store.create(later);
    comment(editor, later.id);

    const earlier = newThread(newMessage('bob', 'sur le bloc a'), 'a');
    editor.setSelection(range('a', 0, 'a', 7));
    store.create(earlier);
    comment(editor, earlier.id);

    const ordered = threadsInDocumentOrder(editor.doc, store, ['a', 'b']);
    expect(ordered.map((thread) => thread.messages[0]!.body)).toEqual(['sur le bloc a', 'sur le bloc b']);
  });

  it('leaves orphans out of the ordered list', () => {
    const editor = doc();
    const store = memoryComments();
    store.create(newThread(newMessage('alice', 'sans ancre')));
    expect(threadsInDocumentOrder(editor.doc, store, ['a', 'b'])).toEqual([]);
  });
});

describe('reading order is not iteration order', () => {
  it('documentOrder walks the tree depth-first from the root', () => {
    const editor = new Editor();
    seed(editor, 'a', 'premier');
    seed(editor, 'b', 'deuxième');
    // a child of the second block, which iteration order would misplace
    const child: Block = {
      id: 'b1',
      type: 'paragraph',
      version: 1,
      props: {},
      text: [{ text: 'enfant' }],
      children: [],
      parentId: 'b',
    };
    editor.dispatch((tx) => tx.op({ type: 'insert_block', block: child, index: 0 }), { addToHistory: false });
    seed(editor, 'c', 'troisième');

    expect(documentOrder(editor.doc)).toEqual([editor.doc.rootId, 'a', 'b', 'b1', 'c']);
  });

  it('sorts threads by where their anchors read, not where they were made', () => {
    const editor = new Editor();
    seed(editor, 'a', 'premier bloc');
    seed(editor, 'b', 'deuxième bloc');
    const store = memoryComments();

    const second = newThread(newMessage('alice', 'sur b'), 'b');
    editor.setSelection(range('b', 0, 'b', 8));
    store.create(second);
    comment(editor, second.id);

    const first = newThread(newMessage('bob', 'sur a'), 'a');
    editor.setSelection(range('a', 0, 'a', 7));
    store.create(first);
    comment(editor, first.id);

    const ordered = threadsInDocumentOrder(editor.doc, store, documentOrder(editor.doc));
    expect(ordered.map((thread) => thread.messages[0]!.body)).toEqual(['sur a', 'sur b']);
  });
});

/**
 * Two people discussing the same paragraph is the normal case. Applying a mark
 * replaces any mark of the same type on the range — which took the first
 * thread's anchor away and dropped a live discussion into the orphan list while
 * the block it was about was still there.
 */
describe('two threads on one block', () => {
  it('both keep their anchor', () => {
    let runs: Run[] = [{ text: 'un paragraphe' }];
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'a' } }, true);
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'b' } }, true);

    const ids = (runs[0]!.marks ?? []).map((m) => m.attrs?.['threadId']);
    expect(ids).toEqual(['a', 'b']);
  });

  it('re-anchoring the same thread does not duplicate it', () => {
    let runs: Run[] = [{ text: 'un paragraphe' }];
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'a' } }, true);
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'a' } }, true);
    expect((runs[0]!.marks ?? []).length).toBe(1);
  });

  it('removing one leaves the other', () => {
    let runs: Run[] = [{ text: 'un paragraphe' }];
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'a' } }, true);
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'b' } }, true);
    runs = applyMark(runs, 0, 13, { type: 'comment', attrs: { threadId: 'a' } }, false);

    expect((runs[0]!.marks ?? []).map((m) => m.attrs?.['threadId'])).toEqual(['b']);
  });

  it('a mark that is its type still replaces, so text is bold or it is not', () => {
    let runs: Run[] = [{ text: 'gras' }];
    runs = applyMark(runs, 0, 4, { type: 'bold' }, true);
    runs = applyMark(runs, 0, 4, { type: 'bold' }, true);
    expect((runs[0]!.marks ?? []).length).toBe(1);
    // and a second link on the same words replaces the first, as before
    runs = applyMark(runs, 0, 4, { type: 'link', attrs: { href: 'a' } }, true);
    runs = applyMark(runs, 0, 4, { type: 'link', attrs: { href: 'b' } }, true);
    expect((runs[0]!.marks ?? []).filter((m) => m.type === 'link').map((m) => m.attrs?.['href'])).toEqual(['b']);
  });
});
