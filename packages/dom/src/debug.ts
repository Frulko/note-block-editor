import type { EditorFeature } from './features';

/**
 * Freeze the chrome so it can be looked at.
 *
 * @remarks
 * Every floating thing this editor draws is bound to the pointer being
 * somewhere: the gutter follows the hovered block, the block toolbar hides
 * 250ms after the pointer leaves, a menu closes on the first press outside it.
 * All of which is right, and all of which makes the chrome impossible to
 * inspect — moving the mouse toward the devtools is the gesture that dismisses
 * the thing you were going to inspect, and screenshotting it is a race.
 *
 * So: `⌥⇧D` pins whatever is currently up. While it is pinned the hover stops
 * being recomputed and an outside press stops dismissing, so the gutter, the
 * open handle menu and any popover under it stay exactly where they are and
 * can be walked through in the inspector. **Escape still closes**, always —
 * a debug mode with no way out is a bug of its own.
 *
 * Off by default and not in {@link defaultFeatures}: this is a tool for
 * whoever is styling the editor, not a mode to leave in front of a reader.
 *
 * @category Configuration
 */

/** The attribute everything else reads. On `<body>`, because the chrome is portaled there. */
export const DEBUG_ATTR = 'nbeDebugHold';

/** True while the chrome is pinned. Cheap enough for a hover path. */
export function debugHolding(): boolean {
  return typeof document !== 'undefined' && document.body?.dataset[DEBUG_ATTR] !== undefined;
}

export const debugFeature: EditorFeature = {
  name: 'debug-hold',
  attach(view) {
    let badge: HTMLElement | null = null;

    const show = (on: boolean) => {
      if (!on) {
        badge?.remove();
        badge = null;
        return;
      }
      badge = document.createElement('div');
      badge.className = 'nbe-debug-badge';
      badge.dataset['nbeUi'] = '';
      badge.textContent = 'Chrome figé — ⌥⇧D ou Échap';
      document.body.append(badge);
    };

    const set = (on: boolean) => {
      if (on) document.body.dataset[DEBUG_ATTR] = '';
      else delete document.body.dataset[DEBUG_ATTR];
      show(on);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape always leaves, whatever else is listening for it
      if (e.key === 'Escape' && debugHolding()) {
        set(false);
        return;
      }
      if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      e.stopPropagation();
      set(!debugHolding());
    };

    // capture, and on the document: the point is to work while a menu has
    // taken the keyboard, which is exactly when there is something to look at
    document.addEventListener('keydown', onKeyDown, true);
    void view;
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      set(false);
    };
  },
};
