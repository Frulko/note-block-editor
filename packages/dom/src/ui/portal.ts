/**
 * Mounting chrome outside the editor element.
 *
 * @remarks
 * Floating chrome — menus, toolbars, the drag ghost, the drop guide, the
 * rubber band — is appended to `document.body` so no `overflow: hidden` and no
 * stacking context inside the editor can clip it. That has one consequence
 * that is easy to miss and expensive to find: **the design tokens do not
 * inherit**, because they are declared on the editor element.
 *
 * They used to be declared on a hand-written list of eight class names
 * instead, one per floating component, which drifted the moment a ninth was
 * added. Measured on 2026-08-07: the drop guide and the drag ghost both
 * resolved `--nbe-accent-rgb` to nothing and painted `rgba(0, 0, 0, 0)` — the
 * drop indicator was literally invisible, which is most of why dragging felt
 * broken.
 *
 * So there is one marker class instead of a list, applied here. Anything that
 * reaches `document.body` goes through this function, and `test/portals.test.ts`
 * fails the build if a new `document.body.append` appears that does not.
 *
 * @category UI
 */
const PORTAL_CLASS = 'nbe-portal';

/** Append floating chrome to the document, carrying the token scope with it. */
export function mountPortal(el: HTMLElement): void {
  el.classList.add(PORTAL_CLASS);
  document.body.append(el);
}
