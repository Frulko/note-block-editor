import type { EditorView } from './view';

/**
 * Margin rubber-band selection (Notion): press on empty editor space and drag
 * to draw a rectangle; top-level blocks intersecting its vertical range become
 * a block selection.
 */
let lastBandEnd = 0;

/** True right after a rubber band ended, so the trailing click is ignored. */
export function justRubberBanded(): boolean {
  return Date.now() - lastBandEnd < 300;
}

export function attachRubberBand(view: EditorView): () => void {
  const editor = view.editor;
  const box = document.createElement('div');
  box.className = 'nbe-rubberband';
  let origin: { x: number; y: number } | null = null;
  let active = false;

  const stop = (keepSelection: boolean) => {
    if (active) {
      lastBandEnd = Date.now();
      box.remove();
      document.body.classList.remove('nbe-drag-active');
      const sel = editor.selection;
      // drop the native text selection the browser built under the pointer,
      // then release the gesture only after the resulting selectionchange has
      // been swallowed — otherwise it maps back to a text selection and wipes
      // the block selection we just made
      document.getSelection()?.removeAllRanges();
      if (keepSelection && sel?.kind === 'block') editor.setSelection(sel, 'keyboard');
      else if (!keepSelection) editor.setSelection(null, 'keyboard');
      requestAnimationFrame(() => {
        view.blockGesture = false;
      });
    } else {
      view.blockGesture = false;
    }
    active = false;
    origin = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onAbort);
    window.removeEventListener('blur', onAbort);
    document.removeEventListener('keydown', onKey, { capture: true });
  };

  const onAbort = () => stop(false);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      stop(false);
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!origin) return;
    if (!active) {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= 4) return;
      active = true;
      view.blockGesture = true;
      document.body.append(box);
      document.body.classList.add('nbe-drag-active');
      document.addEventListener('keydown', onKey, { capture: true });
    }
    // the browser also drag-selects text under the pointer; keep it out of view
    document.getSelection()?.removeAllRanges();
    const top = Math.min(origin.y, e.clientY);
    const bottom = Math.max(origin.y, e.clientY);
    box.style.top = `${top}px`;
    box.style.left = `${Math.min(origin.x, e.clientX)}px`;
    box.style.height = `${bottom - top}px`;
    box.style.width = `${Math.abs(e.clientX - origin.x)}px`;

    const hits = [...view.content.querySelectorAll<HTMLElement>(':scope > .nbe-block')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > top && r.top < bottom;
    });
    if (hits.length) {
      editor.setSelection(
        {
          kind: 'block',
          anchor: hits[0]!.dataset['blockId']!,
          head: hits[hits.length - 1]!.dataset['blockId']!,
        },
        'dom', // no focus/scroll side effects while the band is live
      );
    } else {
      editor.setSelection(null, 'dom');
    }
  };

  const onUp = () => stop(true);

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // from empty editor space, or from an empty leaf: an empty paragraph
    // showing its placeholder must not trap the gesture — dragging out of it
    // is how you start selecting after clicking into blank space
    const target = e.target as HTMLElement;
    const emptyLeaf = target.classList?.contains('nbe-leaf') && !target.textContent;
    if (target !== view.content && !emptyLeaf) return;
    e.preventDefault();
    origin = { x: e.clientX, y: e.clientY };
    try {
      view.content.setPointerCapture(e.pointerId); // survives off-window release
    } catch {
      /* synthetic pointers */
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onAbort);
    window.addEventListener('blur', onAbort);
  };

  view.content.addEventListener('pointerdown', onDown);
  return () => {
    stop(false);
    view.content.removeEventListener('pointerdown', onDown);
  };
}
