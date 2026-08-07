import type { DomBlockPlugin } from '../block-view';

/**
 * No built-in block plugins ship from `@nbe/dom`.
 *
 * Deliberately empty rather than a barrel of everything: Tiptap's `StarterKit`
 * statically imports about twenty extensions, so `configure({ heading: false })`
 * turns a block off and leaves its code in the bundle. Ergonomics and
 * tree-shaking are in direct conflict there and the kit wins.
 *
 * A host composes the array it wants:
 *
 * ```ts
 * import { callout } from '@nbe/blocks-callout/dom'
 * new EditorView(el, editor, { blocks: [callout] })
 * ```
 *
 * The block types still built into the view's switch are not plugins yet;
 * they need no registration.
 */
export const builtinBlocks: DomBlockPlugin[] = [];
