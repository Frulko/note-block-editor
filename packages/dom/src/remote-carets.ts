import { selectedBlocks, type Editor } from '@nbe/core';
import type { EditorView } from './view';
import { modelPointToDom } from './selection';
import { toContainerPoint } from './ui/position';
import { reveal } from './viewport';

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
 * **Nothing here is in the editing surface, but everything is inside the
 * editor.** The layer is a `pointer-events: none` sibling of the blocks, inside
 * `.nbe-editor` and outside every `contenteditable` leaf — an element inside a
 * leaf becomes part of the text, and the browser would let a person put their
 * cursor inside someone else's name badge.
 *
 * It sits there rather than in a portal for the reason the gutter learned
 * first: chrome on `document.body` follows the *window's* scroll and not the
 * editor's, so a caret drifted away from the text inside any scrolling host and
 * escaped over the top of a pane that was supposed to clip it. Positions are
 * therefore container coordinates, and a re-render re-attaches the layer.
 *
 * @category Collaboration
 */

/**
 * Where a peer is.
 *
 * @remarks
 * The two shapes are the model's own two selections. Text is a caret when the
 * points are equal and a range otherwise; blocks is someone holding whole
 * blocks, which has no caret at all and so cannot be squeezed into the first
 * shape without drawing it somewhere it is not.
 */
export type RemoteSelection =
  | {
      kind?: 'text';
      blockId: string;
      anchor: number;
      head: number;
      /** Set only when the head is in another block, so a range crossing blocks paints. */
      headBlockId?: string;
    }
  | { kind: 'blocks'; ids: string[] };

/** A peer, as this package needs to see one. */
export interface RemotePeer {
  id: string;
  name?: string;
  /** Any CSS colour. Chosen by the peer so it is stable between sessions. */
  color?: string;
  selection?: RemoteSelection | null;
}

/**
 * This editor's selection, flattened into what a peer needs to see.
 *
 * @remarks
 * It lives here rather than in each host because every host was writing it, and
 * every host was writing the same two bugs: dropping the selection whenever it
 * crossed a block, and publishing nothing at all for a block selection. Both
 * made a peer *disappear* from the other screens at the moment they were doing
 * the most visible thing in the document.
 *
 * It takes the editor rather than the selection because expanding a block
 * selection into the blocks it holds needs the document's order — and the peer
 * that made the selection is the one that certainly has it.
 *
 * @category Collaboration
 */
export function peerSelection(editor: Editor): RemoteSelection | null {
  const selection = editor.selection;
  if (!selection) return null;
  if (selection.kind === 'block') {
    return { kind: 'blocks', ids: selectedBlocks(editor.doc, selection) };
  }
  const { anchor, head } = selection;
  return {
    blockId: anchor.blockId,
    anchor: anchor.offset,
    head: head.offset,
    ...(head.blockId === anchor.blockId ? {} : { headBlockId: head.blockId }),
  };
}

/**
 * How many peers can be painted at once.
 *
 * @remarks
 * `::highlight()` takes a literal name — it cannot be generated at runtime and
 * a stylesheet cannot match a pattern. So the names are a fixed pool with a
 * rule each (`style/ui.css`), and a peer takes a slot for the duration of a
 * paint. Registering a name with no rule behind it is what the first version
 * did, and it painted nothing at all, silently.
 *
 * Beyond the pool a peer still gets a caret, which is the part that says where
 * someone is; eight simultaneous *selections* in one document is already past
 * what anyone can read.
 */
export const PEER_SLOTS = 8;
const highlightName = (slot: number): string => `nbe-peer-${slot}`;

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
/**
 * Following someone: the viewport goes where they go.
 *
 * @remarks
 * It belongs here rather than in each host for the same reason
 * {@link peerSelection} does — every host would write it, and every host would
 * write the same two mistakes. The first is scrolling on every update, which
 * fights the reader over a document they can already see; `reveal` moves only
 * when the target is off screen, which is what following actually means. The
 * second is having no way out: a person who starts reading somewhere else is
 * *saying* they have stopped following, so a press inside the editor ends it.
 */
export interface FollowControl {
  /** Go with this peer, or stop. Following a peer who is not here is a no-op. */
  follow(peerId: string | null): void;
  /** Who is being followed, if anyone. */
  following(): string | null;
  /** Told whenever that changes, including when the editor ends it. */
  onFollowChange(handler: (peerId: string | null) => void): () => void;
}

export function attachRemoteCarets(view: EditorView): FollowControl & {
  update(peers: readonly RemotePeer[]): void;
  destroy(): void;
} {
  const highlights = registry();
  const layer = document.createElement('div');
  layer.className = 'nbe-peers';

  let followed: string | null = null;
  const followHandlers = new Set<(peerId: string | null) => void>();

  const setFollowed = (peerId: string | null): void => {
    if (followed === peerId) return;
    followed = peerId;
    for (const handler of followHandlers) handler(followed);
  };

  /** The block a peer is in, whichever shape their selection has. */
  const blockOf = (selection: RemoteSelection): string | null =>
    selection.kind === 'blocks' ? (selection.ids[0] ?? null) : (selection.headBlockId ?? selection.blockId);

  /**
   * Put the followed peer on screen.
   *
   * @remarks
   * `nearest`, so a peer already visible moves nothing: following someone
   * typing in a paragraph you are both looking at must not scroll the page on
   * every keystroke.
   */
  const keepUp = (peers: readonly RemotePeer[]): void => {
    if (!followed) return;
    const peer = peers.find((p) => p.id === followed);
    const id = peer?.selection ? blockOf(peer.selection) : null;
    const el = id ? view.blockEl(id) : null;
    if (el) reveal(el);
  };

  /*
   * Moving your own cursor *is* saying you have stopped following.
   *
   * The first attempt was a `pointerdown` listener on the editing surface, and
   * `test/restraint.test.ts` refused it: one press has one owner here, the
   * gesture router, and "just one more listener" is the arbitration bug that
   * router exists to prevent. Being made to find another way found a better
   * one — this is the local selection moving, so it covers the arrow keys and
   * typing as well as a click, which a press listener never would.
   *
   * Every origin but `remote` counts: `remote` is somebody else's edit landing,
   * and being dragged along by it is precisely what following *is*.
   */
  const stopOnLocalMove = view.editor.onSelection((_selection, origin) => {
    if (origin !== 'remote') setFollowed(null);
  });

  /** Which highlight names we own, so we clear ours and nobody else's. */
  let painted: string[] = [];
  /** The last thing we were told, so a re-render can be repainted from it. */
  let last: readonly RemotePeer[] = [];

  const clearHighlights = (): void => {
    for (const name of painted) highlights?.delete(name);
    painted = [];
  };

  const update = (peers: readonly RemotePeer[]): void => {
    last = peers;
    clearHighlights();
    layer.replaceChildren();
    // a re-render replaced the editor's children, this layer among them
    if (layer.parentElement !== view.content) view.content.append(layer);

    let slot = 0;

    for (const peer of peers) {
      const selection = peer.selection;
      if (!selection) continue;
      const colour = peer.color ?? 'currentColor';

      /*
       * Whole blocks: an outline per block rather than a highlight, because a
       * highlight paints text and what is held here is the block — including
       * an image or a divider, which have no text to paint at all.
       */
      if (selection.kind === 'blocks') {
        let first = true;
        for (const id of selection.ids) {
          const el = view.blockEl(id);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const at = toContainerPoint(view.content, rect.left, rect.top);
          const box = document.createElement('div');
          box.className = 'nbe-peer-block';
          box.style.left = `${at.x}px`;
          box.style.top = `${at.y}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          box.style.borderColor = colour;
          box.style.background = `color-mix(in srgb, ${colour} 12%, transparent)`;
          if (first && peer.name) {
            const label = document.createElement('span');
            label.className = 'nbe-peer-name';
            label.textContent = peer.name;
            label.style.background = colour;
            box.append(label);
            first = false;
          }
          layer.append(box);
        }
        continue;
      }

      const from = modelPointToDom(view, { blockId: selection.blockId, offset: selection.anchor });
      const to = modelPointToDom(view, {
        blockId: selection.headBlockId ?? selection.blockId,
        offset: selection.head,
      });
      if (!from || !to) continue; // a block we are not showing: not an error

      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        // a backwards selection produces an inverted range; swap rather than drop
        if (range.collapsed && (from.node !== to.node || from.offset !== to.offset)) {
          range.setStart(to.node, to.offset);
          range.setEnd(from.node, from.offset);
        }
      } catch {
        continue; // the document moved under us; the next paint will be right
      }

      if (!range.collapsed && highlights && slot < PEER_SLOTS) {
        const name = highlightName(slot++);
        highlights.set(name, new Highlight(range));
        painted.push(name);
        /*
         * A highlight's colour cannot be set per instance, only per rule. The
         * rule reads a custom property off the editor, and the translucency is
         * applied here because a peer's colour is any CSS colour and only
         * `color-mix` can add an alpha to one it has not parsed.
         */
        view.content.style.setProperty(`--${name}`, `color-mix(in srgb, ${colour} 26%, transparent)`);
      }

      /*
       * The caret sits at the head — where the person actually is — so it is
       * measured from its own collapsed range. Taking the end of the painted
       * range instead would put it at the wrong end of every backwards
       * selection, which is most of the ones made by dragging leftwards.
       */
      const headRange = document.createRange();
      headRange.setStart(to.node, to.offset);
      headRange.collapse(true);
      const rects = headRange.getClientRects();
      const rect = rects.length ? rects[rects.length - 1]! : headRange.getBoundingClientRect();
      const at = toContainerPoint(view.content, rect.right, rect.top);
      const caret = document.createElement('div');
      caret.className = 'nbe-peer-caret';
      caret.style.left = `${at.x}px`;
      caret.style.top = `${at.y}px`;
      caret.style.height = `${rect.height || 18}px`;
      caret.style.background = colour;
      // also as `color`, so the followed halo can be drawn from `currentColor`
      // instead of the stylesheet needing a value only this code knows
      caret.style.color = colour;

      if (peer.id === followed) caret.classList.add('nbe-peer-followed');

      if (peer.name) {
        const label = document.createElement('span');
        label.className = 'nbe-peer-name';
        label.textContent = peer.name;
        label.style.background = colour;
        caret.append(label);
      }
      layer.append(caret);
    }

    keepUp(peers);
  };

  /*
   * A re-render replaces the blocks these positions were measured against — and
   * this layer with them. Repainting from the last state keeps other people
   * where they are instead of leaving them at the coordinates the document had
   * before the edit, which is the same class of lie `redrawOnRemote` exists for.
   */
  const stopRedraw = view.editor.on(() => update(last));

  return {
    update,

    follow(peerId) {
      setFollowed(peerId);
      keepUp(last);
    },
    following: () => followed,
    onFollowChange(handler) {
      followHandlers.add(handler);
      return () => followHandlers.delete(handler);
    },

    destroy() {
      stopRedraw();
      stopOnLocalMove();
      followHandlers.clear();
      clearHighlights();
      layer.remove();
    },
  };
}
