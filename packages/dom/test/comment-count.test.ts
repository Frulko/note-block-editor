// @vitest-environment happy-dom
//
// The margin badge says how many comments a block has. The document can only
// count *threads* — a thread anchors itself as a `comment` mark and two replies
// in one thread are still one mark — so a block with one discussion of two
// messages wore a "1" beside a panel showing both. Reported 2026-08-10 with a
// screenshot of exactly that.
//
// `commentCount` existed for this and had been implemented by one host out of
// four, silently. `commentStore` is the same answer asked for differently: hand
// over the store you already have.
import { describe, expect, it } from 'vitest';
import { Editor, docFromJSON, memoryComments, newMessage, newThread } from '@nbe/core';
import { EditorView } from '../src/view';
import { commentMarkersFeature } from '../src/features';

const doc = () =>
  docFromJSON({
    id: 'root',
    type: 'page',
    version: 1,
    children: [
      {
        id: 'b1',
        type: 'paragraph',
        version: 1,
        text: [{ text: 'un paragraphe', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] }],
      },
    ],
  });

/** Mount with the given options and read the badge. */
function mount(options: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({ doc: doc() });
  const view = new EditorView(host, editor, {
    features: [commentMarkersFeature],
    onComment: () => {},
    ...options,
  });
  return { view, badge: () => host.querySelector('.nbe-comment-count')?.textContent ?? null };
}

describe('the number beside a commented block', () => {
  it('counts threads when nothing else can say — all the document knows', () => {
    const { badge } = mount({});
    expect(badge()).toBe('1');
  });

  it('counts messages when the host hands over its store', () => {
    const store = memoryComments();
    const thread = newThread(newMessage('a', 'Hello :)', 'Visiteur'), 'b1');
    thread.id = 't1';
    store.create(thread);
    store.addMessage('t1', newMessage('a', 'nope !', 'Visiteur'));

    const { badge } = mount({ commentStore: store });
    expect(badge()).toBe('2');
  });

  it('follows a reply, which changes no block and so fires no edit', () => {
    const store = memoryComments();
    const thread = newThread(newMessage('a', 'Hello :)', 'Visiteur'), 'b1');
    thread.id = 't1';
    store.create(thread);

    const { badge } = mount({ commentStore: store });
    expect(badge()).toBe('1');

    store.addMessage('t1', newMessage('b', 'une réponse', 'Quelqu’un'));
    expect(badge()).toBe('2');
  });

  it('lets an explicit commentCount win, for a host that counts its own way', () => {
    const store = memoryComments();
    const thread = newThread(newMessage('a', 'x', 'V'), 'b1');
    thread.id = 't1';
    store.create(thread);
    store.addMessage('t1', newMessage('a', 'y', 'V'));

    const { badge } = mount({ commentStore: store, commentCount: () => 9 });
    expect(badge()).toBe('9');
  });
});
