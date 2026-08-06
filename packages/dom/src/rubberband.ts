import type { EditorView } from './view';

/**
 * Margin rubber-band selection (Notion): press on empty editor space and drag
 * to draw a rectangle; top-level blocks intersecting its vertical range become
 * a block selection.
 */
export function attachRubberBand(view: EditorView): () => void {
  const editor = view.editor;
  const box = document.createElement('div');
  box.className = 'nbe-rubberband';
  let origin: { x: number; y: number } | null = null;
  let active = false;

  const stop = (keepSelection: boolean) => {
    if (active) {
      box.remove();
      document.body.classList.remove('nbe-drag-active');
      const sel = editor.selection;
      if (keepSelection && sel?.kind === 'block') editor.setSelection(sel, 'keyboard');
      else if (!keepSelection) editor.setSelection(null, 'keyboard');
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
      document.body.append(box);
      document.body.classList.add('nbe-drag-active');
      document.addEventListener('keydown', onKey, { capture: true });
    }
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
    // only from empty editor space — presses on blocks keep native text selection
    if (e.target !== view.content) return;
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
