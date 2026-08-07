import type { DomBlockPlugin } from '../block-view';
import { calloutPlugin } from './callout';

/**
 * The built-in set, as a plain array literal.
 *
 * Deliberately *not* a barrel that imports everything and disables at runtime:
 * that is Tiptap's `StarterKit`, where `configure({ heading: false })` turns a
 * block off but leaves its code in the bundle. Ergonomics and tree-shaking are
 * in direct conflict there, and the kit wins. An array a host can copy and
 * edit keeps day-one ergonomics and stays actually removable on day two.
 */
export const builtinBlocks: DomBlockPlugin[] = [calloutPlugin];

export { calloutPlugin };
