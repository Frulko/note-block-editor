import type { Block, BlockId } from '@nbe/core';
import { childIndex, getBlock, plainText, textLength, uuidv7 } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, type MenuEntry } from './ui';
import { viewOf } from './block-view';
import type { EditorLabels } from './labels';

interface SlashItem {
  label: string;
  keywords: string[];
  icon: string;
  action:
    | { kind: 'block'; type: string; props?: Record<string, unknown> }
    // a plugin that inserts something other than one block: a subtree, or a
    // block that needs a host record created first
    | { kind: 'custom'; insert: (view: EditorView, afterBlockId: BlockId) => BlockId | null }
    | { kind: 'divider' }
    | { kind: 'page' }
    | { kind: 'database' };
}

/** Built per view: labels are per view. Blocks contribute their own on top. */
const builtinItems = (labels: EditorLabels): SlashItem[] => [
  { label: labels.text, keywords: ['text', 'p'], icon: 'pilcrow', action: { kind: 'block', type: 'paragraph' } },
  { label: labels.heading1, keywords: ['h1', 'heading'], icon: 'H1', action: { kind: 'block', type: 'heading', props: { level: 1 } } },
  { label: labels.heading2, keywords: ['h2', 'heading'], icon: 'H2', action: { kind: 'block', type: 'heading', props: { level: 2 } } },
  { label: labels.heading3, keywords: ['h3', 'heading'], icon: 'H3', action: { kind: 'block', type: 'heading', props: { level: 3 } } },
  { label: labels.bulletedList, keywords: ['bullet', 'ul'], icon: '•', action: { kind: 'block', type: 'bulleted_list_item' } },
  { label: labels.numberedList, keywords: ['number', 'ol'], icon: '1.', action: { kind: 'block', type: 'numbered_list_item' } },
  { label: labels.todo, keywords: ['todo', 'check', 'task'], icon: 'square-check', action: { kind: 'block', type: 'to_do' } },
  { label: labels.toggle, keywords: ['toggle', 'collapse'], icon: 'chevron-right', action: { kind: 'block', type: 'toggle' } },
  { label: labels.quote, keywords: ['quote'], icon: 'quote', action: { kind: 'block', type: 'quote' } },
  { label: labels.image, keywords: ['image', 'img', 'photo'], icon: 'image', action: { kind: 'block', type: 'image' } },
  { label: labels.divider, keywords: ['divider', 'hr'], icon: '—', action: { kind: 'divider' } },
  { label: labels.page, keywords: ['page', 'subpage'], icon: 'file-text', action: { kind: 'page' } },
  { label: labels.database, keywords: ['database', 'db'], icon: 'database', action: { kind: 'database' } },
];

/** Built-in entries plus everything the registered plugins contribute. */
export function slashItems(view: EditorView): SlashItem[] {
  const contributed: SlashItem[] = [];
  for (const plugin of view.plugins.all()) {
    const declared = viewOf(plugin)?.slash;
    if (!declared) continue;
    for (const entry of Array.isArray(declared) ? declared : [declared]) {
      if (entry.available?.(view) === false) continue;
      contributed.push({
        label: entry.label,
        keywords: entry.keywords,
        icon: entry.icon,
        action: entry.insert
          ? { kind: 'custom', insert: entry.insert }
          : { kind: 'block', type: plugin.schema.type, props: entry.props },
      });
    }
  }
  return [...builtinItems(view.labels), ...contributed];
}

export function filterItems(query: string, hasPages: boolean, hasDb = hasPages, items: SlashItem[] = []): SlashItem[] {
  const q = query.toLowerCase().trim();
  const matched = items.filter((item) => {
    if (item.action.kind === 'page' && !hasPages) return false;
    if (item.action.kind === 'database' && !hasDb) return false;
    if (!q) return true;
    return (
      item.label.toLowerCase().includes(q) || item.keywords.some((k) => k.toLowerCase().includes(q))
    );
  });
  if (!q) return matched;
  /*
   * A label that *starts* with what was typed is what was meant. Without this
   * the order was registration order, so `/table` reached whichever entry
   * merely mentions tables before it reached "Tableau" — and the first entry
   * is the one Enter takes. Stable, so registration order still breaks ties.
   */
  const rank = (item: SlashItem): number =>
    item.label.toLowerCase().startsWith(q) ? 0 : item.keywords.some((k) => k.toLowerCase().startsWith(q)) ? 1 : 2;
  return matched.sort((a, b) => rank(a) - rank(b));
}

export function attachSlashMenu(view: EditorView): () => void {
  const editor = view.editor;
  let open = false;
  let blockId: BlockId = '';
  let triggerOffset = 0; // offset of the '/' character

  const menu = createMenu({
    className: 'nbe-slash-menu',
    onClose: () => {
      open = false;
    },
  });

  const toEntries = (items: SlashItem[]): MenuEntry[] =>
    items.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => select(item) }));

  const openAt = (id: BlockId, offset: number) => {
    if (!view.leafEl(id)) return;
    blockId = id;
    triggerOffset = offset;
    open = true;
    menu.update(toEntries(filterItems('', !!view.options.onCreatePage, !!view.options.database, slashItems(view))));
    // live anchor: re-resolved on scroll/re-render, so it survives leaf replacement
    menu.open(() => view.leafEl(blockId)?.getBoundingClientRect() ?? null, {
      placement: 'bottom-start',
    });
  };

  const select = (item: SlashItem) => {
    const block = getBlock(editor.doc, blockId);
    const caret = editor.selection?.kind === 'text' ? editor.selection.head.offset : triggerOffset + 1;
    const queryEnd = caret;
    const willBeEmpty = textLength(block.text) - (queryEnd - triggerOffset) === 0;
    // snapshot: `block` is the live doc object, so after the tx converts it in
    // place `block.type` already reads the new type — testing it later sent the
    // caret to the next block instead of the one just created
    const convertInPlace = willBeEmpty && block.type === 'paragraph';

    const newBlock = (type: string, props: Record<string, unknown> = {}): Block => ({
      id: uuidv7(),
      type,
      version: 1,
      props,
      text: [],
      children: [],
      parentId: block.parentId,
    });


    // a subtree is not a type conversion: clear the query, then let the
    // plugin build and focus whatever it inserts (a table is three block types)
    if (item.action.kind === 'custom') {
      const insert = item.action.insert;
      editor.dispatch((tx) => tx.op({ type: 'delete_text', id: blockId, from: triggerOffset, to: queryEnd }), {
        origin: 'input',
      });
      insert(view, blockId);
      return;
    }

    const resolve = (): { type: string; props?: Record<string, unknown>; extraParagraph?: boolean } | null => {
      if (item.action.kind === 'block') {
        /*
         * A void block has no caret to leave the user in, so inserting one as
         * the last thing on a page left nowhere to type — and the schema is
         * what knows that, which is why this is derived rather than declared
         * per entry. It was declared per entry, and every plugin-contributed
         * void block (a table of contents, say) was silently missing it.
         */
        return {
          type: item.action.type,
          props: item.action.props,
          extraParagraph: !editor.schema.get(item.action.type).inline,
        };
      }
      if (item.action.kind === 'divider') return { type: 'divider', extraParagraph: true };
      if (item.action.kind === 'database') {
        const created = view.options.database?.create();
        if (!created) return null;
        return { type: 'database', props: { collectionId: created.collectionId }, extraParagraph: true };
      }
      const page = view.options.onCreatePage?.();
      if (!page) return null;
      return { type: 'link_to_page', props: { pageId: page.pageId, title: page.title }, extraParagraph: true };
    };
    const target = resolve();
    if (!target) return;
    const defaults = editor.schema.get(target.type).defaultProps ?? {};
    const props = { ...defaults, ...target.props };

    editor.dispatch(
      (tx) => {
        tx.op({ type: 'delete_text', id: blockId, from: triggerOffset, to: queryEnd });
        if (convertInPlace) {
          tx.op({ type: 'update_block', id: blockId, patch: { type: target.type, props } });
          if (target.extraParagraph) {
            tx.op({ type: 'insert_block', block: newBlock('paragraph'), index: childIndex(editor.doc, blockId) + 1 });
          }
        } else {
          const b = newBlock(target.type, props);
          tx.op({ type: 'insert_block', block: b, index: childIndex(editor.doc, blockId) + 1 });
          if (target.extraParagraph && target.type !== 'divider') {
            tx.op({ type: 'insert_block', block: newBlock('paragraph'), index: childIndex(editor.doc, b.id) + 1 });
          }
        }
      },
      { origin: 'input' },
    );

    // caret placement: converted/inserted inline block → inside it; void block → paragraph after
    const doc = editor.doc;
    const focusTarget = (() => {
      const converted = doc.blocks.get(blockId);
      if (convertInPlace && converted && editor.schema.get(converted.type).inline)
        return converted.id;
      const parent = converted ? getBlock(doc, converted.parentId ?? doc.rootId) : getBlock(doc, doc.rootId);
      const after = parent.children
        .slice(parent.children.indexOf(blockId) + 1)
        .map((id) => doc.blocks.get(id))
        .find((b) => b && editor.schema.get(b.type).inline);
      return after?.id ?? null;
    })();
    if (focusTarget) view.focusBlock(focusTarget, 0);
  };

  const update = () => {
    const sel = editor.selection;
    if (sel?.kind !== 'text' || sel.head.blockId !== blockId) return menu.close();
    const caret = sel.head.offset;
    if (caret <= triggerOffset) return menu.close();
    const block = editor.doc.blocks.get(blockId);
    if (!block) return menu.close();
    const text = plainText(block.text);
    if (text[triggerOffset] !== '/') return menu.close();
    const query = text.slice(triggerOffset + 1, caret);
    if (query.length > 12) return menu.close();
    menu.update(toEntries(filterItems(query, !!view.options.onCreatePage, !!view.options.database, slashItems(view))));
  };

  const unsubChange = editor.on((change) => {
    if (!open) {
      const op = change.ops[change.ops.length - 1];
      if (
        change.origin === 'input' &&
        op?.type === 'insert_text' &&
        plainText(op.runs) === '/' &&
        editor.selection?.kind === 'text'
      ) {
        openAt(op.id, op.offset);
      }
      return;
    }
    update();
  });

  return () => {
    unsubChange();
    menu.close();
  };
}
