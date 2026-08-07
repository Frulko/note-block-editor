import type { Block, BlockId } from '@nbe/core';
import { resolveDrop, type DropCandidate, type DropTarget } from './drop';
import { mountPortal } from './ui/portal';
import {
  blockCategory,
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
  createActionButton,
  createDragGhost,
  createHoverZone,
  createMenu,
  draggable,
  dragMechanics,
  findScrollParent,
  type DragGhost,
  type MenuEntry,
} from './ui';

type Edge = 'before' | 'after' | 'left' | 'right';

import { COLORS } from './colors';
import { isActiveTarget, turnIntoTargets } from './block-types';
import { blockActionEntries } from './block-actions';
import { format } from './labels';
import type { GestureRecognizer } from './gestures';

export function attachControls(view: EditorView): () => void {
  const editor = view.editor;
  const labels = view.labels;

  /**
   * Blocks a user can grab, drop next to, or open a menu on. Layout containers
   * are transparent — you act on what they hold — with the table as the one
   * exception: it is the unit you move, and its menu owns the row and column
   * actions, so its rows and cells stay out of the way.
   */
  const standalone = (type: string): boolean => {
    if (type === 'table') return true;
    if (type === 'table_row' || type === 'table_cell') return false;
    return blockCategory(editor.schema, type) !== 'layout';
  };

  // --- floating hover controls ---
  const controls = document.createElement('div');
  controls.className = 'nbe-controls';
  controls.dataset['nbeUi'] = '';
  const plusBtn = createActionButton({
    title: 'Ajouter un bloc en dessous',
    icon: 'plus',
    iconSize: 18,
    className: 'nbe-ctrl-btn nbe-plus',
    preserveSelection: true,
    onClick: () => insertBelow(),
  });
  const handleBtn = createActionButton({
    title: labels.dragHandle,
    icon: 'grip-vertical',
    iconSize: 18,
    className: 'nbe-ctrl-btn nbe-handle',
    popover: true,
    // the drag session owns the press; the factory's click only opens the menu
    onClick: () => {},
  });
  controls.append(plusBtn, handleBtn);

  let hoveredId: BlockId | null = null;

  const showControlsFor = (blockEl: HTMLElement) => {
    hoveredId = blockEl.dataset['blockId']!;
    const rect = blockEl.getBoundingClientRect();
    mountPortal(controls);
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
      return !!id && editor.doc.blocks.has(id) && standalone(getBlock(editor.doc, id).type);
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
  function insertBelow() {
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
  }

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
        label: labels.duplicate,
        hint: '⌘D',
        onSelect: () => {
          duplicateBlocks(editor, ids);
          view.announce(labels.blockDuplicated);
        },
      },
      {
        label: labels.delete,
        hint: '⌫',
        onSelect: () => {
          deleteBlocks(editor, ids);
          view.announce(labels.blockDeleted);
        },
      },
      {
        label: labels.copyBlockLink,
        onSelect: () => {
          void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#${first}`);
          view.announce(labels.linkCopied);
        },
      },
      {
        label: labels.moveUp,
        hint: '⌘⇧↑',
        onSelect: () => {
          moveBlocksVertical(editor, ids, 'up');
          view.announce(labels.blockMovedUp);
        },
      },
      {
        label: labels.moveDown,
        hint: '⌘⇧↓',
        onSelect: () => {
          moveBlocksVertical(editor, ids, 'down');
          view.announce(labels.blockMovedDown);
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
    if (typeEntries.length) entries.push({ kind: 'section', label: labels.thisBlock }, ...typeEntries);

    if (editor.schema.get(block.type).inline) {
      entries.push({ kind: 'section', label: labels.turnInto });
      for (const t of turnIntoTargets(view)) {
        entries.push({
          label: t.label,
          icon: t.icon,
          hint: isActiveTarget(t, block) ? '✓' : undefined,
          onSelect: () => {
            for (const id of ids) turnInto(editor, id, t.type, t.props);
            view.announce(format(labels.turnedInto, { type: t.label }));
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

    entries.push({ kind: 'section', label: labels.textColor }, { kind: 'custom', el: swatchRow('color') });
    entries.push({ kind: 'section', label: labels.backgroundColor }, { kind: 'custom', el: swatchRow('backgroundColor') });
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
  let drop: DropTarget | null = null;

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

  /** Every block the pointer may drop onto, measured. */
  const dropCandidates = (): DropCandidate[] => {
    const out: DropCandidate[] = [];
    for (const el of view.content.querySelectorAll<HTMLElement>('.nbe-block')) {
      const id = el.dataset['blockId'];
      if (!id || !editor.doc.blocks.has(id)) continue;
      if (!standalone(getBlock(editor.doc, id).type)) continue;
      if (isDraggedOrInside(id)) continue;
      const r = el.getBoundingClientRect();
      out.push({ id, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
    }
    return out;
  };

  /**
   * Draw the indicator: a line where the block will land.
   *
   * @remarks
   * A 2px line in the accent colour with a dot at its head, which is the
   * convention Atlassian documents and Notion uses — horizontal between two
   * blocks, vertical against the edge that would become a column. It replaces
   * a translucent 140px slab that was meant to look "catchable" and instead
   * read as a selection of the area it covered.
   */
  const drawGuide = (target: DropTarget) => {
    const el = view.blockEl(target.id);
    if (!el) return void (guide.style.display = 'none');
    const r = el.getBoundingClientRect();
    const side = target.edge === 'left' || target.edge === 'right';
    guide.classList.toggle('nbe-guide-side', side);
    guide.style.display = 'block';
    if (side) {
      guide.style.top = `${r.top + window.scrollY}px`;
      guide.style.height = `${r.height}px`;
      guide.style.width = '';
      guide.style.left = `${(target.edge === 'left' ? r.left : r.right) + window.scrollX}px`;
    } else {
      guide.style.left = `${r.left + window.scrollX}px`;
      guide.style.width = `${r.width}px`;
      guide.style.height = '';
      guide.style.top = `${(target.edge === 'before' ? r.top : r.bottom) + window.scrollY}px`;
    }
  };

  const updateDrop = (e: PointerEvent) => {
    ghost?.move(e.clientX, e.clientY);
    drop = resolveDrop(e.clientX, e.clientY, dropCandidates(), {
      columns: view.options.columns !== false,
      previous: drop,
    });
    if (!drop) guide.style.display = 'none';
    else drawGuide(drop);
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
    const { id: targetId, edge } = drop;
    if (!editor.doc.blocks.has(targetId) || !dragIds.every((id) => editor.doc.blocks.has(id))) return;
    if (edge === 'left' || edge === 'right') {
      moveIntoColumns(editor, dragIds, targetId, edge);
      view.announce(labels.columnsCreated);
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
      view.announce(labels.blockMoved);
    }
  };

  /** Blocks a gesture starting on `id` should move: the selection, or just it. */
  const dragTargets = (id: BlockId | null): BlockId[] => {
    if (!id || !editor.doc.blocks.has(id)) return [];
    const sel = editor.selection;
    if (sel?.kind === 'block') {
      const ids = selectedBlocks(editor.doc, sel);
      if (ids.includes(id)) return ids; // dragging one of them drags them all
    }
    return [id];
  };

  const beginDrag = (e: PointerEvent, ids: BlockId[]): boolean => {
    if (!ids.length) return false;
    menu.close();
    dragIds = ids;
    hover.freeze(true);
    document.body.classList.add('nbe-drag-active');
    const sources = dragIds.map((id) => view.blockEl(id)).filter((el): el is HTMLElement => el !== null);
    for (const el of sources) el.classList.add('nbe-drag-source');
    ghost = createDragGhost(sources, { count: dragIds.length });
    ghost.move(e.clientX, e.clientY);
    mountPortal(guide);
    controls.classList.add('nbe-ctrl-hidden');
    return true;
  };

  const endDrag = (commit: boolean) => {
    try {
      if (commit) commitDrop();
    } finally {
      cleanupDrag();
      hover.hide();
    }
  };

  /*
   * Second drag source, alongside the ⋮⋮ handle: press-and-drag directly on a
   * block. Allowed for VOID blocks (an image has no caret, so a press on it is
   * a grab, not an edit) and for any block that is part of the current block
   * selection — which is what makes a rubber-band selection immediately
   * reorderable without hunting for the handle.
   */
  /**
   * Direct drag contributed to the gesture router instead of a competing
   * pointerdown listener on the content. It is the highest-precedence
   * recognizer: a press that qualifies must not first be read as text
   * selection, which is what decided it before, by attach order.
   */
  const blockDragRecognizer: GestureRecognizer = {
    name: 'block-drag',
    match(ctx) {
      if (ctx.onChrome && !ctx.target.closest('.nbe-t-image, .nbe-t-link_to_page')) return false;
      if (!ctx.blockId) return false;
      const type = getBlock(editor.doc, ctx.blockId).type;
      if (!standalone(type)) return false;
      const sel = editor.selection;
      const inSelection = sel?.kind === 'block' && selectedBlocks(editor.doc, sel).includes(ctx.blockId);
      // void blocks have no caret to compete with, so they drag on contact;
      // everything else has to be selected first, or typing would move blocks
      return blockCategory(editor.schema, type) === 'void' || inSelection;
    },
    start(ctx) {
      const ids = dragTargets(ctx.blockId);
      if (!ids.length) return null; // decline; a later recognizer may take it
      ctx.event.preventDefault();
      const mechanics = dragMechanics(ctx.event, {
        scrollContainer: () => findScrollParent(view.content),
        onStart: (e) => beginDrag(e, ids),
        onMove: updateDrop,
        onDrop: () => endDrag(true),
        onCancel: () => endDrag(false),
      });
      return { mode: 'block', move: mechanics.move, end: mechanics.end };
    },
  };

  // highest precedence: a qualifying press must not first read as text
  view.recognizers.unshift(blockDragRecognizer);

  const unDrag = draggable(handleBtn, {
    onTap: () => toggleMenu(),
    scrollContainer: () => findScrollParent(view.content),
    onStart: (e) => {
      menu.close();
      dragIds = dragTargets(hoveredId);
      if (!dragIds.length) return false;
      return beginDrag(e, dragIds);
    },
    onMove: updateDrop,
    onDrop: () => endDrag(true),
    onCancel: () => endDrag(false),
  });

  return () => {
    hover.destroy();
    menu.close();
    unDrag();
    const i = view.recognizers.indexOf(blockDragRecognizer);
    if (i >= 0) view.recognizers.splice(i, 1);
    controls.remove();
    ghost?.destroy();
    guide.remove();
  };
}
