import type { BlockId, Run } from '@nbe/core';
import { textCaret } from '@nbe/core';
import type { EditorView } from './view';
import { attachTriggerMenu } from './trigger-menu';

/**
 * Inline page mentions: `@` opens a picker, choosing inserts a live reference.
 *
 * @remarks
 * §2.4 keeps three constructs apart on purpose, and this is the third: a
 * sub-page is a block in the tree, a link-to-page is an alias block, and a
 * mention is a **rich-text span that resolves the live title**. The last one
 * is why a mention is a mark rather than a block — it sits inside a sentence,
 * and it must follow a rename.
 *
 * "Follows a rename" is the whole design constraint. The run's text is what
 * the title was when it was inserted; the renderer asks the host for the
 * current one and shows that instead. The stored text is the fallback for
 * when the host cannot resolve — an unloaded workspace, a deleted page, or a
 * static export — so a mention degrades to readable text rather than to
 * nothing.
 *
 * Backlinks are a derived index over these, never authored data.
 *
 * @category Blocks
 */

export const MENTION_MARK = 'mention';

/** A page the host offers for `@` completion. */
export interface MentionCandidate {
  pageId: string;
  title: string;
  icon?: string;
}

/** The runs a chosen mention becomes: the reference, then a trailing space. */
export function mentionRuns(candidate: MentionCandidate): Run[] {
  return [
    { text: candidate.title, marks: [{ type: MENTION_MARK, attrs: { pageId: candidate.pageId } }] },
    { text: ' ' },
  ];
}

export function attachMentions(view: EditorView): () => void {
  const editor = view.editor;

  return attachTriggerMenu<MentionCandidate>(view, {
    trigger: '@',
    className: 'nbe-mention-menu',
    // a mention query is a page title, so it can be longer than a command name
    maxQuery: 48,
    enabled: () => !!view.options.onSearchPages,
    items: (query) => view.options.onSearchPages?.(query) ?? [],
    entry: (c) => ({ label: c.title, icon: c.icon ?? 'file-text' }),
    select: (candidate, blockId: BlockId, [from, to]) => {
      const runs = mentionRuns(candidate);
      const length = runs.reduce((n, r) => n + r.text.length, 0);
      editor.dispatch(
        (tx) => {
          // one transaction, so undo removes the mention in a single step
          tx.op({ type: 'delete_text', id: blockId, from, to });
          tx.op({ type: 'insert_text', id: blockId, offset: from, runs });
        },
        { origin: 'input', selection: textCaret(blockId, from + length) },
      );
      view.syncDomSelection();
    },
  });
}
