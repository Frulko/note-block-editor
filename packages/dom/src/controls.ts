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
import {
  attachTooltip,
  icon,
  createDragGhost,
  createHoverZone,
  createMenu,
  draggable,
  findScrollParent,
  type DragGhost,
  type MenuEntry,
} from './ui';

type Edge = 'before' | 'after' | 'left' | 'right';

import { COLORS } from './colors';
import { isActiveTarget, TURN_INTO } from './block-types';
import { blockActionEntries } from './block-actions';

export function attachControls(view: EditorView): () => void {
  const editor = view.editor;

  // --- floating hover controls ---
  const controls = document.createElement('div');
  controls.className = 'nbe-controls';
  controls.dataset['nbeUi'] = '';
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'nbe-ctrl-btn nbe-plus';
  plusBtn.append(icon('plus', { size: 18 }));
  plusBtn.setAttribute('aria-label', 'Ajouter un bloc en dessous');
  const handleBtn = document.createElement('button');
  handleBtn.type = 'button';
  handleBtn.className = 'nbe-ctrl-btn nbe-handle';
  handleBtn.append(icon('grip-vertical', { size: 18 }));
  handleBtn.setAttribute('aria-label', 'Menu du bloc (glisser pour déplacer)');
  handleBtn.setAttribute('aria-haspopup', 'menu');
  controls.append(plusBtn, handleBtn);
  const unTooltips = [
    attachTooltip(plusBtn, 'Cliquer pour ajouter en dessous'),
    attachTooltip(handleBtn, 'Glisser pour déplacer\nCliquer pour ouvrir le menu'),
  ];

  let hoveredId: BlockId | null = null;

  const showControlsFor = (blockEl: HTMLElement) => {
    hoveredId = blockEl.dataset['blockId']!;
    const rect = blockEl.getBoundingClientRect();
    document.body.append(controls);
    // align to the block's first line rather than its box, so the gutter sits
    // next to the text on tall blocks (callouts, code, images)
    const line = parseFloat(getComputedStyle(blockEl).lineHeight) || 24;
    const padTop = parseFloat(getComputedStyle(blockEl).paddingTop) || 0;
    const top = rect.top + padTop + Math.max(0, (line - controls.offsetHeight || 0) / 2);
    controls.style.top = `${top + window.scrollY}px`;
    controls.style.left = `${rect.left + window.scrollX - controls.offsetWidth - 6}px`;
  };

  const hideControls = () => {
    hoveredId = null;
    controls.remove();
  };

  /**
   * Proximity-based resolution (Notion): the gutter appears when the pointer
   * is *near* a block, not strictly over it. The catch area extends well into
   * the left margin — where the gutter itself lives — and a little past the
   * right edge, which is where comment/actions will hang. Vertically we pick
   * the nearest block within a small tolerance, so the gutter never blinks in
   * the gaps between blocks.
   */
  const HOVER_LEFT = 120; // generous: the gutter sits out here
  const HOVER_RIGHT = 80; // reserved for right-side actions (comments…)
  const HOVER_Y = 8;

  const resolveBlock = (e: MouseEvent): HTMLElement | null => {
    const c = view.content.getBoundingClientRect();
    if (e.clientX < c.left - HOVER_LEFT || e.clientX > c.right + HOVER_RIGHT) return null;
    if (e.clientY < c.top - HOVER_Y || e.clientY > c.bottom + HOVER_Y) return null;

    const eligible = (el: HTMLElement): boolean => {
      const id = el.dataset['blockId'];
      if (!id || !editor.doc.blocks.has(id)) return false;
      const type = getBlock(editor.doc, id).type;
      return type !== 'column_list' && type !== 'column';
    };

    // exact hit first (cheap, and correct for nested blocks)
    const x = Math.min(Math.max(e.clientX, c.left + 4), c.right - 4);
    const under = document.elementFromPoint(x, e.clientY) as HTMLElement | null;
    const direct = under?.closest?.('.nbe-block') as HTMLElement | null;
    if (direct && eligible(direct)) return direct;

    // otherwise the vertically nearest block within tolerance
    let best: { el: HTMLElement; distance: number } | null = null;
    for (const el of view.content.querySelectorAll<HTMLElement>('.nbe-block')) {
      if (!eligible(el)) continue;
      const r = el.getBoundingClientRect();
      const distance = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      if (distance > HOVER_Y) continue;
      // deepest match wins ties so nested blocks keep their own gutter
      if (!best || distance < best.distance || (distance === best.distance && best.el.contains(el))) {
        best = { el, distance };
      }
    }
    return best?.el ?? null;
  };

  const hover = createHoverZone({
    resolve: resolveBlock,
    isChrome: (t) =>
      t instanceof Node && (controls.contains(t) || menu.el.contains(t) || (t as HTMLElement).closest?.('.nbe-tooltip') != null),
    onTarget: showControlsFor,
    onClear: hideControls,
  });

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

  // --- block menu (generic menu primitive) ---
  const menu = createMenu({
    className: 'nbe-block-menu',
    isOutsideExempt: (t) => controls.contains(t),
    onClose: () => hover.freeze(false),
  });

  const menuTargets = (): BlockId[] => {
    const sel = editor.selection;
    if (sel?.kind === 'block') {
      const ids = selectedBlocks(editor.doc, sel);
      if (hoveredId && ids.includes(hoveredId)) return ids;
    }
    return hoveredId ? [hoveredId] : [];
  };

  const buildMenuEntries = (ids: BlockId[]): MenuEntry[] => {
    const first = ids[0]!;
    const entries: MenuEntry[] = [
      {
        label: 'Dupliquer',
        hint: '⌘D',
        onSelect: () => {
          duplicateBlocks(editor, ids);
          view.announce('Bloc dupliqué');
        },
      },
      {
        label: 'Supprimer',
        hint: '⌫',
        onSelect: () => {
          deleteBlocks(editor, ids);
          view.announce('Bloc supprimé');
        },
      },
      {
        label: 'Copier le lien du bloc',
        onSelect: () => {
          void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#${first}`);
          view.announce('Lien copié');
        },
      },
      {
        label: 'Déplacer vers le haut',
        hint: '⌘⇧↑',
        onSelect: () => {
          moveBlocksVertical(editor, ids, 'up');
          view.announce('Bloc déplacé vers le haut');
        },
      },
      {
        label: 'Déplacer vers le bas',
        hint: '⌘⇧↓',
        onSelect: () => {
          moveBlocksVertical(editor, ids, 'down');
          view.announce('Bloc déplacé vers le bas');
        },
      },
    ];

    const block = getBlock(editor.doc, first);

    // type-specific actions (callout icon, code language, image source…)
    const typeEntries = blockActionEntries({
      view,
      ids,
      block,
      anchor: handleBtn,
      close: () => menu.close(),
    });
    if (typeEntries.length) entries.push({ kind: 'section', label: 'Ce bloc' }, ...typeEntries);

    if (editor.schema.get(block.type).inline) {
      entries.push({ kind: 'section', label: 'Transformer en' });
      for (const t of TURN_INTO) {
        entries.push({
          label: t.label,
          icon: t.icon,
          hint: isActiveTarget(t, block) ? '✓' : undefined,
          onSelect: () => {
            for (const id of ids) turnInto(editor, id, t.type, t.props);
            view.announce(`Transformé en ${t.label}`);
          },
        });
      }
    }

    const swatchRow = (kind: 'color' | 'backgroundColor') => {
      const swatches = document.createElement('div');
      swatches.className = 'nbe-menu-swatches';
      for (const c of COLORS) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'nbe-swatch';
        sw.title = c.label;
        sw.textContent = 'A';
        if (kind === 'color') sw.style.color = c.text;
        else {
          sw.style.background = c.background;
          if (c.name === 'default') sw.style.color = 'rgba(55,53,47,0.4)';
        }
        if (block.props[kind] === c.name || (c.name === 'default' && !block.props[kind])) {
          sw.classList.add('nbe-active');
        }
        sw.addEventListener('mousedown', (e) => e.preventDefault());
        sw.addEventListener('click', () => {
          menu.close();
          const value = c.name === 'default' ? undefined : c.name;
          editor.dispatch(
            (tx) => {
              for (const id of ids) tx.op({ type: 'update_block', id, patch: { props: { [kind]: value } } });
            },
            { origin: 'ui' },
          );
          view.announce(`${kind === 'color' ? 'Couleur' : 'Fond'} ${c.label}`);
        });
        swatches.append(sw);
      }
      return swatches;
    };

    entries.push({ kind: 'section', label: 'Couleur du texte' }, { kind: 'custom', el: swatchRow('color') });
    entries.push({ kind: 'section', label: 'Couleur de fond' }, { kind: 'custom', el: swatchRow('backgroundColor') });
    return entries;
  };

  const toggleMenu = () => {
    if (menu.isOpen) {
      menu.close();
      return;
    }
    const ids = menuTargets();
    if (!ids.length) return;
    hover.freeze(true);
    menu.update(buildMenuEntries(ids));
    menu.open(() => handleBtn.getBoundingClientRect(), { placement: 'bottom-start', offset: 4 });
  };

  // --- drag & drop (drag session primitive, ARCHITECTURE §7 / D8) ---
  let dragIds: BlockId[] = [];
  let drop: { targetId: BlockId; edge: Edge } | null = null;

  let ghost: DragGhost | null = null;
  const guide = document.createElement('div');
  guide.className = 'nbe-drop-guide';

  const isDraggedOrInside = (id: BlockId): boolean => {
    // defensive walk: missing blocks or (impossible-by-invariant) cycles must
    // degrade to "not droppable here", never freeze the page mid-drag
    let p: BlockId | null = id;
    for (let depth = 0; p !== null && depth < 200; depth++) {
      if (dragIds.includes(p)) return true;
      const block = editor.doc.blocks.get(p);
      if (!block) return true;
      p = block.parentId;
    }
    return p !== null; // depth cap hit — treat as unsafe target
  };

  const updateDrop = (e: PointerEvent) => {
    ghost?.move(e.clientX, e.clientY);

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

    /*
     * Drop zones sized for the hand, not for the pixel. The side bands scale
     * with the block (a quarter of its width, clamped) instead of a fixed
     * 48px, and they are skipped entirely on short blocks where they would
     * eat the whole target. Hysteresis: once a side is engaged it stays
     * engaged a little past its boundary, so a shaky pointer does not flicker
     * between "make a column" and "move below".
     */
    const sideBand = Math.min(140, Math.max(64, rect.width * 0.25));
    const tall = rect.height >= 28;
    const wideEnough = rect.width > sideBand * 2 + 40;
    const sticky = drop?.targetId === id && (drop.edge === 'left' || drop.edge === 'right') ? 24 : 0;

    let edge: Edge;
    if (wideEnough && tall && e.clientX < rect.left + sideBand + sticky) edge = 'left';
    else if (wideEnough && tall && e.clientX > rect.right - sideBand - sticky) edge = 'right';
    else edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';

    drop = { targetId: id, edge };
    guide.classList.toggle('nbe-guide-side', edge === 'left' || edge === 'right');
    guide.style.display = 'block';
    if (edge === 'left' || edge === 'right') {
      // paint the whole band, not a hairline: the target should look catchable
      guide.style.top = `${rect.top + window.scrollY}px`;
      guide.style.height = `${rect.height}px`;
      guide.style.width = `${sideBand}px`;
      guide.style.left = `${(edge === 'left' ? rect.left : rect.right - sideBand) + window.scrollX}px`;
    } else {
      guide.style.left = `${rect.left + window.scrollX}px`;
      guide.style.width = `${rect.width}px`;
      guide.style.height = '4px';
      guide.style.top = `${(edge === 'before' ? rect.top - 2 : rect.bottom - 2) + window.scrollY}px`;
    }
  };

  const cleanupDrag = () => {
    document.body.classList.remove('nbe-drag-active');
    controls.classList.remove('nbe-ctrl-hidden');
    for (const n of view.content.querySelectorAll('.nbe-drag-source')) n.classList.remove('nbe-drag-source');
    ghost?.destroy();
    ghost = null;
    guide.remove();
    guide.style.display = 'none';
    hover.freeze(false);
    dragIds = [];
    drop = null;
  };

  const commitDrop = () => {
    if (!drop || !dragIds.length) return;
    const { targetId, edge } = drop;
    if (!editor.doc.blocks.has(targetId) || !dragIds.every((id) => editor.doc.blocks.has(id))) return;
    if (edge === 'left' || edge === 'right') {
      moveIntoColumns(editor, dragIds, targetId, edge);
      view.announce('Colonnes créées');
    } else {
      const target = getBlock(editor.doc, targetId);
      const parent = getBlock(editor.doc, target.parentId!);
      const idx = parent.children.indexOf(targetId);
      let after = edge === 'before' ? (idx > 0 ? parent.children[idx - 1]! : null) : targetId;
      while (after !== null && dragIds.includes(after)) {
        const i = parent.children.indexOf(after);
        after = i > 0 ? parent.children[i - 1]! : null;
      }
      moveBlocks(editor, dragIds, parent.id, after);
      view.announce('Bloc déplacé');
    }
  };

  const unDrag = draggable(handleBtn, {
    onTap: () => toggleMenu(),
    scrollContainer: () => findScrollParent(view.content),
    onStart: (e) => {
      menu.close();
      const sel = editor.selection;
      dragIds =
        sel?.kind === 'block' && hoveredId && selectedBlocks(editor.doc, sel).includes(hoveredId)
          ? selectedBlocks(editor.doc, sel)
          : hoveredId
            ? [hoveredId]
            : [];
      if (!dragIds.length) return false;
      hover.freeze(true);
      document.body.classList.add('nbe-drag-active');
      const sources = dragIds.map((id) => view.blockEl(id)).filter((el): el is HTMLElement => el !== null);
      for (const el of sources) el.classList.add('nbe-drag-source');
      ghost = createDragGhost(sources, { count: dragIds.length });
      ghost.move(e.clientX, e.clientY);
      document.body.append(guide);
      // hide, never remove: the handle keeps its pointer capture alive
      controls.classList.add('nbe-ctrl-hidden');
      return true;
    },
    onMove: updateDrop,
    onDrop: () => {
      try {
        commitDrop();
      } finally {
        cleanupDrag();
        hover.hide();
      }
    },
    onCancel: () => {
      cleanupDrag();
      hover.hide();
    },
  });

  return () => {
    hover.destroy();
    menu.close();
    unDrag();
    for (const un of unTooltips) un();
    controls.remove();
    ghost?.destroy();
    guide.remove();
  };
}
