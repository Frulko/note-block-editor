import type { EditorView } from './view';
import { modelPointToDom } from './selection';
import { mountPortal } from './ui/portal';

/**
 * Other people's carets and selections.
 *
 * @remarks
 * **This package knows nothing about CRDTs**, and that is deliberate — the
 * layering is a CI-enforced invariant, and it is what lets the same painting
 * work over a websocket, a loopback, or a recording played back in a demo. So
 * a peer arrives here as plain data: an id, a name, a colour, and a range in
 * the model. Where it came from is the caller's business.
 *
 * **Selections are painted, not held.** The same reason as the local
 * cross-block selection (`cross-block-highlight.ts`): a browser will only hold
 * one `Selection`, and it belongs to the person typing. The Custom Highlight
 * API paints the rest, one highlight per peer so each keeps its own colour.
 *
 * **Carets are elements, because a highlight cannot be a line.** A collapsed
 * range paints nothing, and a caret has to be visible exactly when someone is
 * sitting still and not selecting — which is most of the time. So a caret is a
 * positioned element, and the name rides on it.
 *
 * **Nothing here is in the editing surface.** The carets live in a portal
 * layer with `pointer-events: none`, because an element inside a
 * `contenteditable` becomes part of the text — the browser would let a person
 * put their cursor inside someone else's name badge, and a stray character
 * would end up in the document.
 *
 * @category Collaboration
 */

/** A peer, as this package needs to see one. */
export interface RemotePeer {
  id: string;
  name?: string;
  /** Any CSS colour. Chosen by the peer so it is stable between sessions. */
  color?: string;
  selection?: { blockId: string; anchor: number; head: number } | null;
}

/** The highlight name for one peer. Namespaced so nothing else collides. */
const highlightName = (id: string): string => `nbe-peer-${id.replace(/[^a-z0-9]/gi, '')}`;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistry | null {
  const css = CSS as unknown as { highlights?: HighlightRegistry };
  return typeof Highlight === 'undefined' || !css.highlights ? null : css.highlights;
}

/**
 * Paint remote carets and selections over an editor.
 *
 * @param view - The editor to paint over.
 * @returns `update(peers)` to redraw, and `destroy()` to remove everything.
 *
 * @example
 * ```ts
 * const carets = attachRemoteCarets(view)
 * presence.onChange((peers) => carets.update(Object.entries(peers).map(…)))
 * ```
 */
export function attachRemoteCarets(view: EditorView): {
  update(peers: readonly RemotePeer[]): void;
  destroy(): void;
} {
  const highlights = registry();
  const layer = document.createElement('div');
  layer.className = 'nbe-peers';
  mountPortal(layer);

  /** Which highlight names we own, so we clear ours and nobody else's. */
  let painted: string[] = [];

  const clearHighlights = (): void => {
    for (const name of painted) highlights?.delete(name);
    painted = [];
  };

  const update = (peers: readonly RemotePeer[]): void => {
    clearHighlights();
    layer.replaceChildren();

    const host = view.content.getBoundingClientRect();

    for (const peer of peers) {
      const selection = peer.selection;
      if (!selection) continue;

      const from = modelPointToDom(view, { blockId: selection.blockId, offset: selection.anchor });
      const to = modelPointToDom(view, { blockId: selection.blockId, offset: selection.head });
      if (!from || !to) continue; // a block we are not showing: not an error

      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        continue; // the document moved under us; the next paint will be right
      }
      // a backwards selection is still a selection
      if (range.collapsed && selection.anchor !== selection.head) continue;

      const colour = peer.color ?? 'currentColor';

      if (!range.collapsed && highlights) {
        const name = highlightName(peer.id);
        highlights.set(name, new Highlight(range));
        painted.push(name);
        /*
         * A highlight's colour cannot be set per instance, only per `::highlight()`
         * rule, and those cannot be generated from a stylesheet at runtime. A
         * custom property on the editor, read by a single generic rule, is the
         * way round it that does not inject stylesheets.
         */
        view.content.style.setProperty(`--${name}`, colour);
      }

      // the caret sits at the head, which is where the person actually is
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
      const caret = document.createElement('div');
      caret.className = 'nbe-peer-caret';
      caret.style.left = `${rect.right - host.left + view.content.scrollLeft}px`;
      caret.style.top = `${rect.top - host.top + view.content.scrollTop}px`;
      caret.style.height = `${rect.height || 18}px`;
      caret.style.background = colour;

      if (peer.name) {
        const label = document.createElement('span');
        label.className = 'nbe-peer-name';
        label.textContent = peer.name;
        label.style.background = colour;
        caret.append(label);
      }
      layer.append(caret);
    }

    // the layer follows the editor rather than the page
    const box = view.content.getBoundingClientRect();
    layer.style.left = `${box.left + window.scrollX}px`;
    layer.style.top = `${box.top + window.scrollY}px`;
    layer.style.width = `${box.width}px`;
  };

  return {
    update,
    destroy() {
      clearHighlights();
      layer.remove();
    },
  };
}
