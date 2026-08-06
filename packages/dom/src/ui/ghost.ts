export interface DragGhost {
  /** Follow the pointer. */
  move(x: number, y: number): void;
  destroy(): void;
}

export interface GhostOptions {
  /** Number shown in the badge; the badge is hidden when it is 1 or less. */
  count?: number;
  /** How many source elements to clone into the stack (default 3). */
  maxLayers?: number;
  /** Pointer offset so the ghost sits under the cursor, not on it. */
  offset?: { x: number; y: number };
}

/**
 * A drag preview that follows the pointer: clones of what is being dragged,
 * stacked, with a count badge when several items travel together.
 *
 * In-house because native HTML5 drag images cannot be styled or updated
 * (decision D8) — this is the piece that makes dragging feel physical, and
 * it is shared by block drag and board-card drag.
 */
export function createDragGhost(sources: HTMLElement[], options: GhostOptions = {}): DragGhost {
  const { count = sources.length, maxLayers = 3, offset = { x: 10, y: 8 } } = options;
  const ghost = document.createElement('div');
  ghost.className = 'nbe-ghost';
  ghost.dataset['nbeUi'] = '';

  for (const source of sources.slice(0, maxLayers)) {
    const clone = source.cloneNode(true) as HTMLElement;
    const rect = source.getBoundingClientRect();
    clone.style.width = `${rect.width}px`;
    // clones must never be interactive or focusable while flying
    clone.removeAttribute('contenteditable');
    for (const node of clone.querySelectorAll('[contenteditable]')) node.removeAttribute('contenteditable');
    // a ghost shows what is being MOVED, not what is selected: keep the
    // selection tint out of it, or a grouped drag looks like two overlapping
    // previews (the blue block highlight plus the stack)
    clone.classList.remove('nbe-selected', 'nbe-drag-source');
    for (const node of clone.querySelectorAll('.nbe-selected, .nbe-drag-source')) {
      node.classList.remove('nbe-selected', 'nbe-drag-source');
    }
    for (const node of clone.querySelectorAll('input, button, select, textarea')) {
      (node as HTMLInputElement).disabled = true;
    }
    clone.classList.add('nbe-ghost-layer');
    ghost.append(clone);
  }

  if (count > 1) {
    const badge = document.createElement('div');
    badge.className = 'nbe-ghost-badge';
    badge.textContent = String(count);
    ghost.append(badge);
  }

  document.body.append(ghost);

  return {
    move(x, y) {
      ghost.style.transform = `translate(${x + offset.x}px, ${y + offset.y}px)`;
    },
    destroy() {
      ghost.remove();
    },
  };
}
