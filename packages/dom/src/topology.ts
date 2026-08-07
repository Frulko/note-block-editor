import type { BlockId } from '@nbe/core';

/**
 * Where the editable boundary is — the one thing that separates
 * "one contenteditable per block" (D1) from "a single editable root".
 *
 * The insight that makes this cheap: today's code conflates two different
 * elements under the name "leaf".
 *
 *  - the **leaf** is the element whose text maps 1:1 to a block's model text.
 *    It exists in both topologies, and every selection primitive needs it to
 *    answer "which block, which offset".
 *  - the **host** is the element carrying `contenteditable`. It is what the
 *    browser will and will not drag-select across.
 *
 * Per-block, they are the same element. Single-host, the leaf is a plain div
 * and the host is the content root. Once they are separate names, every
 * interaction module can be written against the host without caring which
 * topology it is running under — and the question the cross-block selection
 * driver actually asks, *"will the browser natively span these two?"*, reduces
 * to `hostOf(a) === hostOf(b)`.
 */
export interface EditableTopology {
  readonly name: 'per-block' | 'single-host';
  /** The contenteditable host containing a node, or null if outside one. */
  hostOf(node: Node | null): HTMLElement | null;
  /** Called on every rendered leaf, to make it editable or not. */
  prepareLeaf(leaf: HTMLElement, blockId: BlockId): void;
  /** Called once on the content root. */
  prepareRoot(root: HTMLElement): void;
}

const PLAINTEXT_ONLY_SUPPORTED = (() => {
  if (typeof document === 'undefined') return false;
  const d = document.createElement('div');
  d.setAttribute('contenteditable', 'plaintext-only');
  return d.contentEditable === 'plaintext-only';
})();

function closestLeaf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return (el?.closest('.nbe-leaf') as HTMLElement) ?? null;
}

function closestRoot(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return (el?.closest('.nbe-editor') as HTMLElement) ?? null;
}

/**
 * D1 as shipped: every leaf is its own `plaintext-only` host.
 *
 * `plaintext-only` is the whole reason this topology is attractive — the
 * browser refuses to inject markup, so the model stays the only source of
 * structure. The fallback to `true` exists because Firefox only shipped
 * `plaintext-only` recently; there the MutationObserver defence carries the
 * weight instead.
 */
export const perBlockTopology: EditableTopology = {
  name: 'per-block',
  hostOf: closestLeaf,
  prepareLeaf(leaf) {
    leaf.setAttribute('contenteditable', PLAINTEXT_ONLY_SUPPORTED ? 'plaintext-only' : 'true');
    // one document tab stop lives on the root (ARCHITECTURE §8)
    leaf.tabIndex = -1;
  },
  prepareRoot(root) {
    root.removeAttribute('contenteditable');
  },
};

/**
 * The alternative D1 never got its spike against: one editable root.
 *
 * It buys native cross-block selection for free and costs a permanently
 * editable container the browser will happily restructure — which is exactly
 * the trade the roadmap wanted measured. Shipping it as a topology is what
 * makes that measurement a config change rather than a rewrite.
 */
export const singleHostTopology: EditableTopology = {
  name: 'single-host',
  hostOf: closestRoot,
  prepareLeaf(leaf) {
    leaf.removeAttribute('contenteditable');
    leaf.removeAttribute('tabindex');
  },
  prepareRoot(root) {
    root.setAttribute('contenteditable', PLAINTEXT_ONLY_SUPPORTED ? 'plaintext-only' : 'true');
  },
};

/** The element whose text maps 1:1 to a block's model text, in any topology. */
export function leafOf(node: Node | null): HTMLElement | null {
  return closestLeaf(node);
}

/**
 * Will the browser natively drag-select from `a` to `b`?
 *
 * Derived rather than implemented per topology: a drag-selection is
 * constrained to the editing host it started in, so the answer is simply
 * whether both ends share one. Per-block that is false across blocks, which
 * is why the cross-block driver exists; single-host it is always true, which
 * switches that driver off without it needing to know why.
 */
export function nativeRangeSpans(
  topology: EditableTopology,
  a: Node | null,
  b: Node | null,
): boolean {
  const ha = topology.hostOf(a);
  const hb = topology.hostOf(b);
  return ha !== null && ha === hb;
}
