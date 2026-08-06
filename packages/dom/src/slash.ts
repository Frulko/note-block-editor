import type { Block, BlockId } from '@nbe/core';
import { childIndex, getBlock, plainText, textCaret, textLength, uuidv7 } from '@nbe/core';
import type { EditorView } from './view';

interface SlashItem {
  label: string;
  keywords: string[];
  icon: string;
  action:
    | { kind: 'block'; type: string; props?: Record<string, unknown> }
    | { kind: 'divider' }
    | { kind: 'page' };
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
  { label: 'Callout', keywords: ['callout', 'encadré', 'info'], icon: '💡', action: { kind: 'block', type: 'callout' } },
  { label: 'Code', keywords: ['code', 'snippet'], icon: '⌨', action: { kind: 'block', type: 'code' } },
  { label: 'Image', keywords: ['image', 'img', 'photo'], icon: '🖼', action: { kind: 'block', type: 'image' } },
  { label: 'Séparateur', keywords: ['divider', 'hr', 'ligne'], icon: '—', action: { kind: 'divider' } },
  { label: 'Page', keywords: ['page', 'sous-page', 'subpage'], icon: '📄', action: { kind: 'page' } },
];

export function filterItems(query: string, hasPages: boolean): SlashItem[] {
  const q = query.toLowerCase().trim();
  return ITEMS.filter((item) => {
    if (item.action.kind === 'page' && !hasPages) return false;
    if (!q) return true;
    return (
      item.label.toLowerCase().includes(q) || item.keywords.some((k) => k.toLowerCase().includes(q))
    );
  });
}

export function attachSlashMenu(view: EditorView): () => void {
  const editor = view.editor;
  const menu = document.createElement('div');
  menu.className = 'nbe-menu nbe-slash-menu';
  menu.dataset['nbeUi'] = '';
  menu.setAttribute('role', 'listbox');

  let open = false;
  let blockId: BlockId = '';
  let triggerOffset = 0; // offset of the '/' character
  let items: SlashItem[] = [];
  let index = 0;
  let anchor: DOMRect | null = null;

  const position = () => {
    if (!anchor) return;
    const menuH = menu.offsetHeight;
    const below = anchor.bottom + 6 + menuH < window.innerHeight;
    menu.style.top = `${(below ? anchor.bottom + 6 : Math.max(8, anchor.top - menuH - 6)) + window.scrollY}px`;
    menu.style.left = `${Math.min(anchor.left, window.innerWidth - 280) + window.scrollX}px`;
  };

  const close = () => {
    if (!open) return;
    open = false;
    menu.remove();
  };

  const renderMenu = () => {
    menu.replaceChildren(
      ...items.map((item, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nbe-menu-item' + (i === index ? ' nbe-active' : '');
        row.setAttribute('role', 'option');
        const icon = document.createElement('span');
        icon.className = 'nbe-menu-icon';
        icon.textContent = item.icon;
        row.append(icon, item.label);
        row.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
        row.addEventListener('click', () => select(item));
        row.addEventListener('mousemove', () => {
          if (index !== i) {
            index = i;
            renderMenu();
          }
        });
        return row;
      }),
    );
    if (!items.length) close();
    else position();
  };

  const openAt = (id: BlockId, offset: number) => {
    // anchored to the trigger block's leaf: deterministic even while the DOM
    // selection is mid-flight during the input pipeline
    const rect = view.leafEl(id)?.getBoundingClientRect() ?? null;
    if (!rect) return;
    blockId = id;
    triggerOffset = offset;
    items = filterItems('', !!view.options.onCreatePage);
    index = 0;
    open = true;
    anchor = rect;
    document.body.append(menu);
    renderMenu();
  };

  const select = (item: SlashItem) => {
    const block = getBlock(editor.doc, blockId);
    const caret = editor.selection?.kind === 'text' ? editor.selection.head.offset : triggerOffset + 1;
    const queryEnd = caret;
    const willBeEmpty = textLength(block.text) - (queryEnd - triggerOffset) === 0;
    close();

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
            const p = newBlock('paragraph');
            tx.op({ type: 'insert_block', block: p, index: childIndex(editor.doc, blockId) + 1 });
          }
        } else {
          const b = newBlock(target.type, props);
          tx.op({ type: 'insert_block', block: b, index: childIndex(editor.doc, blockId) + 1 });
          if (target.extraParagraph && target.type !== 'divider') {
            const p = newBlock('paragraph');
            tx.op({ type: 'insert_block', block: p, index: childIndex(editor.doc, b.id) + 1 });
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
    if (!open) return;
    const sel = editor.selection;
    if (sel?.kind !== 'text' || sel.head.blockId !== blockId) return close();
    const caret = sel.head.offset;
    if (caret <= triggerOffset) return close();
    const block = editor.doc.blocks.get(blockId);
    if (!block) return close();
    const text = plainText(block.text);
    if (text[triggerOffset] !== '/') return close();
    const query = text.slice(triggerOffset + 1, caret);
    if (query.length > 12) return close();
    items = filterItems(query, !!view.options.onCreatePage);
    index = Math.min(index, Math.max(0, items.length - 1));
    renderMenu();
  };

  const unsubChange = editor.on((change) => {
    if (!open) {
      // opening: a lone '/' typed by the user
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length);
        renderMenu();
        return;
      }
      case 'Enter':
      case 'Tab': {
        e.preventDefault();
        e.stopPropagation();
        const item = items[index];
        if (item) select(item);
        return;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    if (open && !menu.contains(e.target as Node)) close();
  };

  view.content.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('mousedown', onMouseDown);
  return () => {
    unsubChange();
    view.content.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('mousedown', onMouseDown);
    close();
  };
}
