import type { Block, BlockId } from '@nbe/core';
import {
  childIndex,
  deleteBlocks,
  duplicateBlocks,
  getBlock,
  insertText,
  moveBlocks,
  moveBlocksVertical,
  moveIntoColumns,
  selectedBlocks,
  textCaret,
  turnInto,
  uuidv7,
} from '@nbe/core';
import type { EditorView } from './view';

type Edge = 'before' | 'after' | 'left' | 'right';

const TURN_INTO: Array<{ label: string; type: string; props?: Record<string, unknown> }> = [
  { label: 'Texte', type: 'paragraph' },
  { label: 'Titre 1', type: 'heading', props: { level: 1 } },
  { label: 'Titre 2', type: 'heading', props: { level: 2 } },
  { label: 'Titre 3', type: 'heading', props: { level: 3 } },
  { label: 'Liste à puces', type: 'bulleted_list_item' },
  { label: 'Liste numérotée', type: 'numbered_list_item' },
  { label: 'Case à cocher', type: 'to_do' },
  { label: 'Toggle', type: 'toggle' },
  { label: 'Citation', type: 'quote' },
  { label: 'Callout', type: 'callout' },
  { label: 'Code', type: 'code' },
];

const COLORS: Array<{ label: string; value: string }> = [
  { label: 'Défaut', value: '' },
  { label: 'Gris', value: 'rgb(120,119,116)' },
  { label: 'Marron', value: 'rgb(159,107,83)' },
  { label: 'Rouge', value: 'rgb(212,76,71)' },
  { label: 'Orange', value: 'rgb(217,115,13)' },
  { label: 'Bleu', value: 'rgb(51,126,169)' },
  { label: 'Violet', value: 'rgb(144,101,176)' },
];

export function attachControls(view: EditorView): () => void {
  const editor = view.editor;

  // --- floating hover controls ---
  const controls = document.createElement('div');
  controls.className = 'nbe-controls';
  controls.dataset['nbeUi'] = '';
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'nbe-ctrl-btn nbe-plus';
  plusBtn.textContent = '+';
  plusBtn.setAttribute('aria-label', 'Ajouter un bloc en dessous');
  const handleBtn = document.createElement('button');
  handleBtn.type = 'button';
  handleBtn.className = 'nbe-ctrl-btn nbe-handle';
  handleBtn.textContent = '⋮⋮';
  handleBtn.setAttribute('aria-label', 'Menu du bloc (glisser pour déplacer)');
  handleBtn.setAttribute('aria-haspopup', 'menu');
  controls.append(plusBtn, handleBtn);

  let hoveredId: BlockId | null = null;

  const hideControls = () => {
    hoveredId = null;
    controls.remove();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragging) return;
    const target = e.target as HTMLElement;
    if (target.closest?.('.nbe-controls, .nbe-menu')) return;
    const blockEl = target.closest?.('.nbe-block') as HTMLElement | null;
    const id = blockEl?.dataset['blockId'];
    if (!id || !editor.doc.blocks.has(id) || getBlock(editor.doc, id).type === 'column_list') {
      if (!menuOpen) hideControls();
      return;
    }
    if (id === hoveredId) return;
    if (menuOpen) return; // freeze while the menu is open
    hoveredId = id;
    const rect = blockEl!.getBoundingClientRect();
    document.body.append(controls);
    controls.style.top = `${rect.top + window.scrollY + 2}px`;
    controls.style.left = `${rect.left + window.scrollX - 50}px`;
  };

  const onMouseLeave = () => {
    if (!menuOpen && !dragging) hideControls();
  };

  // --- plus button: new paragraph below + slash menu ---
  plusBtn.addEventListener('mousedown', (e) => e.preventDefault());
  plusBtn.addEventListener('click', () => {
    if (!hoveredId) return;
    const block = getBlock(editor.doc, hoveredId);
    const p: Block = {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      props: {},
      text: [],
      children: [],
      parentId: block.parentId,
    };
    editor.dispatch(
      (tx) => tx.op({ type: 'insert_block', block: p, index: childIndex(editor.doc, hoveredId!) + 1 }),
      { origin: 'ui', selection: textCaret(p.id, 0) },
    );
    view.syncDomSelection();
    insertText(editor, '/'); // opens the slash menu
  });

  // --- block menu ---
  const menu = document.createElement('div');
  menu.className = 'nbe-menu nbe-block-menu';
  menu.dataset['nbeUi'] = '';
  menu.setAttribute('role', 'menu');
  let menuOpen = false;

  const closeMenu = () => {
    menuOpen = false;
    menu.remove();
  };

  const menuTargets = (): BlockId[] => {
    const sel = editor.selection;
    if (sel?.kind === 'block') {
      const ids = selectedBlocks(editor.doc, sel);
      if (hoveredId && ids.includes(hoveredId)) return ids;
    }
    return hoveredId ? [hoveredId] : [];
  };

  const item = (label: string, hint: string, action: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nbe-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.append(label);
    if (hint) {
      const kbd = document.createElement('span');
      kbd.className = 'nbe-menu-hint';
      kbd.textContent = hint;
      btn.append(kbd);
    }
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      closeMenu();
      action();
    });
    return btn;
  };

  const section = (label: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'nbe-menu-section';
    el.textContent = label;
    return el;
  };

  const openMenu = () => {
    const ids = menuTargets();
    if (!ids.length) return;
    const first = ids[0]!;
    menuOpen = true;
    menu.replaceChildren();

    menu.append(
      item('Dupliquer', '⌘D', () => {
        duplicateBlocks(editor, ids);
        view.announce('Bloc dupliqué');
      }),
      item('Supprimer', '⌫', () => {
        deleteBlocks(editor, ids);
        view.announce('Bloc supprimé');
      }),
      item('Copier le lien du bloc', '', () => {
        const url = `${location.origin}${location.pathname}#${first}`;
        void navigator.clipboard?.writeText(url);
        view.announce('Lien copié');
      }),
      item('Déplacer vers le haut', '⌘⇧↑', () => {
        moveBlocksVertical(editor, ids, 'up');
        view.announce('Bloc déplacé vers le haut');
      }),
      item('Déplacer vers le bas', '⌘⇧↓', () => {
        moveBlocksVertical(editor, ids, 'down');
        view.announce('Bloc déplacé vers le bas');
      }),
    );

    const block = getBlock(editor.doc, first);
    if (editor.schema.get(block.type).inline) {
      menu.append(section('Transformer en'));
      for (const t of TURN_INTO) {
        const active = block.type === t.type && (t.type !== 'heading' || block.props['level'] === t.props?.['level']);
        const btn = item(t.label, active ? '✓' : '', () => {
          for (const id of ids) turnInto(editor, id, t.type, t.props);
          view.announce(`Transformé en ${t.label}`);
        });
        menu.append(btn);
      }
    }

    menu.append(section('Couleur'));
    const swatches = document.createElement('div');
    swatches.className = 'nbe-menu-swatches';
    for (const c of COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'nbe-swatch';
      sw.title = c.label;
      sw.textContent = 'A';
      if (c.value) sw.style.color = c.value;
      sw.addEventListener('mousedown', (e) => e.preventDefault());
      sw.addEventListener('click', () => {
        closeMenu();
        editor.dispatch(
          (tx) => {
            for (const id of ids)
              tx.op({ type: 'update_block', id, patch: { props: { color: c.value || undefined } } });
          },
          { origin: 'ui' },
        );
        view.announce(`Couleur ${c.label}`);
      });
      swatches.append(sw);
    }
    menu.append(swatches);

    document.body.append(menu);
    const hRect = handleBtn.getBoundingClientRect();
    const menuH = Math.min(420, menu.scrollHeight);
    const below = hRect.bottom + menuH + 8 < window.innerHeight;
    menu.style.top = `${(below ? hRect.bottom + 4 : Math.max(8, hRect.top - menuH - 4)) + window.scrollY}px`;
    menu.style.left = `${hRect.left + window.scrollX}px`;
  };

  // --- drag & drop (pointer events, ARCHITECTURE §7) ---
  let dragging = false;
  let dragIds: BlockId[] = [];
  let pointerStart: { x: number; y: number } | null = null;
  let drop: { targetId: BlockId; edge: Edge } | null = null;
  let scrollEl: Element | null = null;
  let rafId = 0;
  let lastClientY = 0;

  const ghost = document.createElement('div');
  ghost.className = 'nbe-ghost';
  const guide = document.createElement('div');
  guide.className = 'nbe-drop-guide';

  const findScrollParent = (): Element => {
    for (let n: Element | null = view.content; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement ?? document.documentElement;
  };

  const startDrag = () => {
    dragging = true;
    const sel = editor.selection;
    dragIds =
      sel?.kind === 'block' && hoveredId && selectedBlocks(editor.doc, sel).includes(hoveredId)
        ? selectedBlocks(editor.doc, sel)
        : hoveredId
          ? [hoveredId]
          : [];
    if (!dragIds.length) {
      dragging = false;
      return;
    }
    scrollEl = findScrollParent();
    document.body.classList.add('nbe-drag-active');
    ghost.replaceChildren();
    for (const id of dragIds.slice(0, 3)) {
      const el = view.blockEl(id);
      if (el) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.width = `${el.getBoundingClientRect().width}px`;
        ghost.append(clone);
      }
      view.blockEl(id)?.classList.add('nbe-drag-source');
    }
    if (dragIds.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'nbe-ghost-badge';
      badge.textContent = String(dragIds.length);
      ghost.append(badge);
    }
    document.body.append(ghost, guide);
    hideControls();
    const scrollLoop = () => {
      if (!dragging || !scrollEl) return;
      const vh = window.innerHeight;
      if (lastClientY < 90) scrollEl.scrollTop -= (90 - lastClientY) / 6;
      else if (lastClientY > vh - 90) scrollEl.scrollTop += (lastClientY - (vh - 90)) / 6;
      rafId = requestAnimationFrame(scrollLoop);
    };
    rafId = requestAnimationFrame(scrollLoop);
  };

  const isDraggedOrInside = (id: BlockId): boolean => {
    for (let p: BlockId | null = id; p !== null; p = getBlock(editor.doc, p).parentId) {
      if (dragIds.includes(p)) return true;
    }
    return false;
  };

  const updateDrop = (e: PointerEvent) => {
    lastClientY = e.clientY;
    ghost.style.top = `${e.clientY + 8}px`;
    ghost.style.left = `${e.clientX + 10}px`;

    let candidate: HTMLElement | null = null;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const blockEl = (el as HTMLElement).closest?.('.nbe-block') as HTMLElement | null;
      const id = blockEl?.dataset['blockId'];
      if (!id || !editor.doc.blocks.has(id)) continue;
      const type = getBlock(editor.doc, id).type;
      if (type === 'column_list' || type === 'column') continue;
      if (isDraggedOrInside(id)) continue;
      candidate = blockEl;
      break;
    }
    if (!candidate) {
      drop = null;
      guide.style.display = 'none';
      return;
    }
    const id = candidate.dataset['blockId']!;
    const rect = candidate.getBoundingClientRect();
    const edge: Edge =
      e.clientX < rect.left + 48
        ? 'left'
        : e.clientX > rect.right - 48
          ? 'right'
          : e.clientY < rect.top + rect.height / 2
            ? 'before'
            : 'after';
    drop = { targetId: id, edge };
    guide.style.display = 'block';
    if (edge === 'left' || edge === 'right') {
      guide.style.top = `${rect.top + window.scrollY}px`;
      guide.style.height = `${rect.height}px`;
      guide.style.width = '3px';
      guide.style.left = `${(edge === 'left' ? rect.left - 4 : rect.right + 1) + window.scrollX}px`;
    } else {
      guide.style.left = `${rect.left + window.scrollX}px`;
      guide.style.width = `${rect.width}px`;
      guide.style.height = '3px';
      guide.style.top = `${(edge === 'before' ? rect.top - 3 : rect.bottom) + window.scrollY}px`;
    }
  };

  const endDrag = (commit: boolean) => {
    cancelAnimationFrame(rafId);
    document.body.classList.remove('nbe-drag-active');
    for (const n of view.content.querySelectorAll('.nbe-drag-source')) n.classList.remove('nbe-drag-source');
    ghost.remove();
    guide.remove();
    guide.style.display = 'none';
    if (commit && drop && dragIds.length) {
      const { targetId, edge } = drop;
      if (edge === 'left' || edge === 'right') {
        moveIntoColumns(editor, dragIds, targetId, edge);
        view.announce('Colonnes créées');
      } else {
        const target = getBlock(editor.doc, targetId);
        const parent = getBlock(editor.doc, target.parentId!);
        const idx = parent.children.indexOf(targetId);
        let after = edge === 'before' ? (idx > 0 ? parent.children[idx - 1]! : null) : targetId;
        // the anchor must not itself be dragged: walk back to a stable sibling
        while (after !== null && dragIds.includes(after)) {
          const i = parent.children.indexOf(after);
          after = i > 0 ? parent.children[i - 1]! : null;
        }
        moveBlocks(editor, dragIds, parent.id, after);
        view.announce('Bloc déplacé');
      }
    }
    dragging = false;
    dragIds = [];
    drop = null;
    pointerStart = null;
  };

  handleBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerStart = { x: e.clientX, y: e.clientY };
    handleBtn.setPointerCapture(e.pointerId);
  });
  handleBtn.addEventListener('pointermove', (e) => {
    if (!pointerStart) return;
    if (!dragging) {
      const dist = Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y);
      if (dist > 4) {
        closeMenu();
        startDrag();
      }
      if (!dragging) return;
    }
    updateDrop(e);
  });
  handleBtn.addEventListener('pointerup', () => {
    if (dragging) {
      endDrag(true);
    } else if (pointerStart) {
      pointerStart = null;
      if (menuOpen) closeMenu();
      else openMenu();
    }
  });
  handleBtn.addEventListener('pointercancel', () => endDrag(false));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (dragging) endDrag(false);
      if (menuOpen) closeMenu();
    }
  };
  const onDocMouseDown = (e: MouseEvent) => {
    if (menuOpen && !menu.contains(e.target as Node) && !controls.contains(e.target as Node)) closeMenu();
  };
  const onScroll = () => {
    if (!menuOpen && !dragging) hideControls();
  };

  view.content.addEventListener('mousemove', onMouseMove);
  view.content.addEventListener('mouseleave', onMouseLeave);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    view.content.removeEventListener('mousemove', onMouseMove);
    view.content.removeEventListener('mouseleave', onMouseLeave);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('scroll', onScroll, { capture: true });
    controls.remove();
    menu.remove();
    ghost.remove();
    guide.remove();
  };
}
