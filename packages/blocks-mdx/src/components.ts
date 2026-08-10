/**
 * What a component tag *is*, when the host knows.
 *
 * @remarks
 * The block itself never evaluates anything, and that is not going to change:
 * running JSX means a component runtime and arbitrary code out of a file
 * somebody handed you, in an editor whose claim is that your notes are plain
 * files. So the file supplies **data** — a name, some attributes, the text
 * between the tags — and the host supplies the **code**, which is code the host
 * wrote and already trusts. `<Counter start={3} />` becomes a real, clickable
 * counter, and nothing from the file was executed to get there.
 *
 * That is the same division every other host hook in this editor makes:
 * `onStoreAsset` does not invent a storage policy, `onSearchPages` does not
 * invent a page store. The module doc has always said « a host that *does* want
 * to render one… this is the fallback, not the ceiling » — this is the
 * ceiling's staircase.
 *
 * A name the host has not registered falls back to the source card, unchanged,
 * which is what makes this additive: an existing mount renders exactly as
 * before.
 *
 * @module @nbe/blocks-mdx/components
 */

/** What the host is handed for one component tag. */
export interface MdxComponentContext {
  /** The tag name, capitalised as JSX requires. */
  name: string;
  /** The attributes, parsed. See {@link parseProps} for what a value becomes. */
  props: Record<string, unknown>;
  /** The raw text between the opening and closing tags; empty when self-closing. */
  children: string;
  /** The block's whole source, verbatim — what will be written back out. */
  source: string;
}

/**
 * Build the element for a component tag, or return null to decline.
 *
 * @remarks
 * Declining is a real answer, not an error path: a renderer registered for
 * `Chart` can refuse a `Chart` whose data it cannot read, and the reader gets
 * the source card rather than a broken picture.
 */
export type MdxComponentRenderer = (ctx: MdxComponentContext) => HTMLElement | null;

/** The host's components, by tag name. */
export type MdxComponents = Record<string, MdxComponentRenderer>;

/**
 * Where the opening tag ends, honouring quotes and braces.
 *
 * @remarks
 * A scanner rather than a pattern, and the nested object is why: `data={{a:1}}`
 * against a non-greedy `\{(.*?)\}` captures `{a:1` — which does not parse as
 * JSON, so it would fall back to being a *string* with a brace missing off the
 * end. A renderer handed that has no way to tell it apart from a value somebody
 * meant. Not supporting nesting would be defensible; supporting it wrongly is
 * not.
 *
 * @returns The index just past the tag's `>`, or the string's length.
 */
function endOfTag(text: string): number {
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
    } else if (c === '{') i = matchBrace(text, i);
    else if (c === '>') return i + 1;
  }
  return text.length;
}

/** Index of the `}` matching the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length;
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /\s/;

/**
 * The props a tag declares.
 *
 * @remarks
 * Quoted values are strings. A braced value is JSON when it parses as JSON —
 * which covers numbers, booleans, arrays and objects, i.e. everything anyone
 * writes as a literal prop — and stays the raw expression text when it does
 * not. It is *not* evaluated: `{count + 1}` arrives as the string `count + 1`
 * and a renderer can do what it likes with that, including nothing.
 *
 * A bare attribute is `true`, which is JSX's own rule.
 */
export function parseProps(openingTag: string): Record<string, unknown> {
  const tag = openingTag.trim();
  // past the component name, and short of the closing `>` (and any `/`)
  const start = /^<[A-Za-z_][\w.]*/.exec(tag)?.[0]?.length ?? 0;
  const inner = tag.slice(start, Math.max(start, endOfTag(tag) - 1)).replace(/\/\s*$/, '');

  const props: Record<string, unknown> = {};
  let i = 0;
  const skipSpace = () => {
    while (i < inner.length && SPACE.test(inner[i]!)) i++;
  };

  while (i < inner.length) {
    skipSpace();
    NAME.lastIndex = i;
    const name = NAME.exec(inner);
    if (!name) break;
    const key = name[0];
    i = NAME.lastIndex;
    skipSpace();

    if (inner[i] !== '=') {
      props[key] = true; // bare attribute: JSX's own rule
      continue;
    }
    i++;
    skipSpace();

    const c = inner[i];
    if (c === '"' || c === "'") {
      const close = inner.indexOf(c, i + 1);
      props[key] = close === -1 ? '' : inner.slice(i + 1, close);
      i = close === -1 ? inner.length : close + 1;
    } else if (c === '{') {
      const close = matchBrace(inner, i);
      const raw = inner.slice(i + 1, close).trim();
      try {
        props[key] = JSON.parse(raw);
      } catch {
        props[key] = raw; // an expression, handed over as text and never run
      }
      i = close + 1;
    } else {
      const from = i;
      while (i < inner.length && !SPACE.test(inner[i]!)) i++;
      props[key] = inner.slice(from, i);
    }
  }
  return props;
}

/** Split a block's source into its opening tag, its inner text and its name. */
export function readTag(source: string): { name: string; openingTag: string; children: string } | null {
  const text = source.trim();
  const name = /^<([A-Z][A-Za-z0-9_.]*)[\s/>]/.exec(text)?.[1];
  if (!name) return null;
  // the same scan the props use, so a `>` inside a prop does not end the tag
  const end = endOfTag(text);
  const openingTag = text.slice(0, end);
  if (/\/\s*>$/.test(openingTag)) return { name, openingTag, children: '' }; // self-closing
  const close = `</${name}>`;
  const at = text.lastIndexOf(close);
  return { name, openingTag, children: at === -1 ? '' : text.slice(end, at) };
}
