import type { BlockId } from '@nbe/core';
import { plainText } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, type MenuEntry } from './ui';

/**
 * A menu opened by typing a character, filtered by what follows it.
 *
 * @remarks
 * The slash menu and the `@` mention picker differ only in what they offer and
 * what they do on select — the mechanics are identical: notice the trigger in
 * an `insert_text` op, remember where it landed, track the caret to derive the
 * query, close when the query stops making sense. Writing that twice is how
 * the two drift, so it lives here once.
 *
 * Closing rules, and each is a bug that would otherwise be found by hand:
 * the caret moving before the trigger, the trigger character being deleted,
 * the block disappearing, or the query growing past what any menu could match.
 *
 * @category UI
 */
export interface TriggerMenuOptions<T> {
  /** The character that opens it. */
  trigger: string;
  className?: string;
  /** Longest query still considered a search rather than prose. */
  maxQuery?: number;
  /** Candidates for the current query. Return empty to close. */
  items: (query: string) => T[];
  entry: (item: T) => Omit<MenuEntry & { label: string }, 'onSelect'>;
  /**
   * Act on the choice.
   *
   * @param item - What was chosen.
   * @param range - The trigger character and query, as `[from, to)` offsets in
   * `blockId` — what a caller replaces.
   */
  select: (item: T, blockId: BlockId, range: [number, number]) => void;
  /** Skip opening at all, e.g. when the host provides no page search. */
  enabled?: () => boolean;
}

export function attachTriggerMenu<T>(view: EditorView, opts: TriggerMenuOptions<T>): () => void {
  const editor = view.editor;
  const maxQuery = opts.maxQuery ?? 24;
  let open = false;
  let blockId: BlockId = '';
  let triggerOffset = 0;

  const menu = createMenu({
    className: opts.className,
    onClose: () => {
      open = false;
    },
  });

  const caretOffset = (): number | null => {
    const sel = editor.selection;
    if (sel?.kind !== 'text' || sel.head.blockId !== blockId) return null;
    return sel.head.offset;
  };

  const render = (query: string): boolean => {
    const items = opts.items(query);
    if (!items.length) return false;
    menu.update(
      items.map((item) => ({
        ...opts.entry(item),
        onSelect: () => {
          const end = caretOffset() ?? triggerOffset + 1;
          menu.close();
          opts.select(item, blockId, [triggerOffset, end]);
        },
      })) as MenuEntry[],
    );
    return true;
  };

  const openAt = (id: BlockId, offset: number) => {
    if (!view.leafEl(id)) return;
    blockId = id;
    triggerOffset = offset;
    if (!render('')) return;
    open = true;
    // live anchor: re-resolved on scroll and re-render, so it survives the
    // leaf being replaced under it
    menu.open(() => view.leafEl(blockId)?.getBoundingClientRect() ?? null, { placement: 'bottom-start' });
  };

  const update = () => {
    const caret = caretOffset();
    if (caret === null || caret <= triggerOffset) return menu.close();
    const block = editor.doc.blocks.get(blockId);
    if (!block) return menu.close();
    const text = plainText(block.text);
    if (text[triggerOffset] !== opts.trigger) return menu.close();
    const query = text.slice(triggerOffset + 1, caret);
    if (query.length > maxQuery) return menu.close();
    if (!render(query)) menu.close();
  };

  const unsub = editor.on((change) => {
    if (!open) {
      const op = change.ops[change.ops.length - 1];
      if (
        change.origin === 'input' &&
        op?.type === 'insert_text' &&
        plainText(op.runs) === opts.trigger &&
        editor.selection?.kind === 'text' &&
        opts.enabled?.() !== false
      ) {
        openAt(op.id, op.offset);
      }
      return;
    }
    update();
  });

  return () => {
    unsub();
    menu.close();
  };
}
