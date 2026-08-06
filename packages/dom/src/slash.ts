import type { Block, BlockId } from '@nbe/core';
import { childIndex, getBlock, plainText, textLength, uuidv7 } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, type MenuEntry } from './ui';

interface SlashItem {
  label: string;
  keywords: string[];
  icon: string;
  action:
    | { kind: 'block'; type: string; props?: Record<string, unknown> }
    | { kind: 'divider' }
    | { kind: 'page' }
    | { kind: 'database' };
}

const ITEMS: SlashItem[] = [
  { label: 'Texte', keywords: ['text', 'paragraphe', 'p'], icon: '¶', action: { kind: 'block', type: 'paragraph' } },
  { label: 'Titre 1', keywords: ['h1', 'heading', 'titre'], icon: 'H1', action: { kind: 'block', type: 'heading', props: { level: 1 } } },
  { label: 'Titre 2', keywords: ['h2', 'heading'], icon: 'H2', action: { kind: 'block', type: 'heading', props: { level: 2 } } },
  { label: 'Titre 3', keywords: ['h3', 'heading'], icon: 'H3', action: { kind: 'block', type: 'heading', props: { level: 3 } } },
  { label: 'Liste à puces', keywords: ['bullet', 'liste', 'ul'], icon: '•', action: { kind: 'block', type: 'bulleted_list_item' } },
  { label: 'Liste numérotée', keywords: ['number', 'liste', 'ol'], icon: '1.', action: { kind: 'block', type: 'numbered_list_item' } },
  { label: 'Case à cocher', keywords: ['todo', 'check', 'tâche', 'task'], icon: '☑', action: { kind: 'block', type: 'to_do' } },
  { label: 'Toggle', keywords: ['toggle', 'dépliant', 'collapse'], icon: '▸', action: { kind: 'block', type: 'toggle' } },
  { label: 'Citation', keywords: ['quote', 'citation'], icon: '❝', action: { kind: 'block', type: 'quote' } },
  { label: 'Callout', keywords: ['callout', 'encadré', 'note'], icon: '💡', action: { kind: 'block', type: 'callout', props: { variant: 'note', backgroundColor: 'gray' } } },
  { label: 'Info', keywords: ['info', 'callout'], icon: 'ℹ️', action: { kind: 'block', type: 'callout', props: { variant: 'info', icon: 'ℹ️', backgroundColor: 'blue' } } },
  { label: 'Attention', keywords: ['warning', 'attention', 'callout'], icon: '⚠️', action: { kind: 'block', type: 'callout', props: { variant: 'warning', icon: '⚠️', backgroundColor: 'yellow' } } },
  { label: 'Succès', keywords: ['success', 'succès', 'callout', 'ok'], icon: '✅', action: { kind: 'block', type: 'callout', props: { variant: 'success', icon: '✅', backgroundColor: 'green' } } },
  { label: 'Erreur', keywords: ['danger', 'erreur', 'error', 'callout'], icon: '🛑', action: { kind: 'block', type: 'callout', props: { variant: 'danger', icon: '🛑', backgroundColor: 'red' } } },
  { label: 'Code', keywords: ['code', 'snippet'], icon: '⌨', action: { kind: 'block', type: 'code' } },
  { label: 'Image', keywords: ['image', 'img', 'photo'], icon: '🖼', action: { kind: 'block', type: 'image' } },
  { label: 'Séparateur', keywords: ['divider', 'hr', 'ligne'], icon: '—', action: { kind: 'divider' } },
  { label: 'Page', keywords: ['page', 'sous-page', 'subpage'], icon: '📄', action: { kind: 'page' } },
  { label: 'Base de données', keywords: ['database', 'table', 'bdd', 'db'], icon: '🗃', action: { kind: 'database' } },
];

export function filterItems(query: string, hasPages: boolean, hasDb = hasPages): SlashItem[] {
  const q = query.toLowerCase().trim();
  return ITEMS.filter((item) => {
    if (item.action.kind === 'page' && !hasPages) return false;
    if (item.action.kind === 'database' && !hasDb) return false;
    if (!q) return true;
    return (
      item.label.toLowerCase().includes(q) || item.keywords.some((k) => k.toLowerCase().includes(q))
    );
  });
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
    menu.update(toEntries(filterItems('', !!view.options.onCreatePage, !!view.options.database)));
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

    const newBlock = (type: string, props: Record<string, unknown> = {}): Block => ({
      id: uuidv7(),
      type,
      version: 1,
      props,
      text: [],
      children: [],
      parentId: block.parentId,
    });

    const resolve = (): { type: string; props?: Record<string, unknown>; extraParagraph?: boolean } | null => {
      if (item.action.kind === 'block') return { type: item.action.type, props: item.action.props };
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
        if (willBeEmpty && block.type === 'paragraph') {
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
      if (willBeEmpty && block.type === 'paragraph' && converted && editor.schema.get(converted.type).inline)
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
    menu.update(toEntries(filterItems(query, !!view.options.onCreatePage, !!view.options.database)));
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
