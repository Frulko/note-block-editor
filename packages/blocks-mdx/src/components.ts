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
  /**
   * Change some of this component's props, in the document.
   *
   * @remarks
   * How a component keeps state across a reload: the state *is* a prop, so it
   * is written into the tag and the file says what the counter is on. Any other
   * MDX tool then reads the same value, and reopening the file brings the
   * component back as it was.
   *
   * It is a real edit — undoable, and it marks the document dirty — because it
   * really does change the file. A component that stores something nobody meant
   * to keep should not call this.
   */
  setProps(patch: Record<string, unknown>): void;
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

/** One attribute, and exactly which bytes of the tag it occupies. */
interface Attribute {
  key: string;
  value: unknown;
  /** Index of the first character of `key`, within the opening tag. */
  from: number;
  /** Index just past the value (or past `key`, when the attribute is bare). */
  to: number;
}

/** Where the attributes start: just past `<Name`. */
const attributesStart = (tag: string): number => /^<[A-Za-z_][\w.]*/.exec(tag)?.[0]?.length ?? 0;

/**
 * Every attribute in an opening tag, with its span.
 *
 * @remarks
 * The spans are what {@link writeProps} needs: rewriting a tag by
 * re-serialising the parsed props would be lossy in a way nobody would notice
 * until their file was wrong. `{count + 1}` parses to the *string*
 * `'count + 1'` — it is not evaluated, deliberately — and writing that back out
 * would emit `="count + 1"`, quietly turning an expression into a string
 * literal. So a rewrite replaces the bytes of the keys it was asked about and
 * leaves every other attribute exactly as it was written, which is the rule
 * `Frontmatter` already follows for keys nobody touched.
 */
export function scanAttributes(openingTag: string): Attribute[] {
  const tag = openingTag.trim();
  const end = Math.max(0, endOfTag(tag) - 1);
  const out: Attribute[] = [];
  let i = attributesStart(tag);

  const skipSpace = () => {
    while (i < end && SPACE.test(tag[i]!)) i++;
  };

  while (i < end) {
    skipSpace();
    if (i >= end || tag[i] === '/') break;
    NAME.lastIndex = i;
    const name = NAME.exec(tag);
    if (!name || name.index !== i) break;
    const key = name[0];
    const from = i;
    i = NAME.lastIndex;
    const afterKey = i;
    skipSpace();

    if (tag[i] !== '=') {
      out.push({ key, value: true, from, to: afterKey }); // bare: JSX's own rule
      continue;
    }
    i++;
    skipSpace();

    const c = tag[i];
    let value: unknown;
    if (c === '"' || c === "'") {
      const close = tag.indexOf(c, i + 1);
      value = close === -1 ? '' : tag.slice(i + 1, close);
      i = close === -1 ? end : close + 1;
    } else if (c === '{') {
      const close = matchBrace(tag, i);
      const raw = tag.slice(i + 1, close).trim();
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw; // an expression, handed over as text and never run
      }
      i = Math.min(close + 1, end);
    } else {
      const at = i;
      while (i < end && !SPACE.test(tag[i]!)) i++;
      value = tag.slice(at, i);
    }
    out.push({ key, value, from, to: i });
  }
  return out;
}

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
  const props: Record<string, unknown> = {};
  for (const attribute of scanAttributes(openingTag)) props[attribute.key] = attribute.value;
  return props;
}

/** A value, as JSX spells it. */
function emit(value: unknown): string {
  // a plain string is a quoted attribute, unless quoting it would need escaping
  if (typeof value === 'string' && !value.includes('"')) return `"${value}"`;
  return `{${JSON.stringify(value)}}`;
}

/**
 * Rewrite a component's source with new values for some of its props.
 *
 * @param source - The block's whole source, opening tag to closing tag.
 * @param patch - Keys to set. `undefined` removes the attribute.
 *
 * @remarks
 * The state a host's component holds *is* a prop, so this is where it belongs:
 * written into the tag, the file says what the counter is on, any other MDX
 * tool reads the same value, and reopening the file brings the component back
 * as it was. The alternative — a marker comment or a frontmatter key — would
 * either break the byte-for-byte promise this block exists for, or need a
 * stable id the block does not persist.
 *
 * Only the patched keys are touched. Everything else keeps the exact bytes it
 * was written with, expressions included.
 */
export function writeProps(source: string, patch: Record<string, unknown>): string {
  const tag = readTag(source);
  if (!tag) return source;
  const open = tag.openingTag;
  const attributes = scanAttributes(open);
  const selfClosing = /\/\s*>$/.test(open);

  // right to left, so an earlier span's indices stay valid
  const edits: Array<{ from: number; to: number; text: string }> = [];
  const added: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const existing = attributes.find((a) => a.key === key);
    if (existing) {
      edits.push({
        from: existing.from,
        to: existing.to,
        text: value === undefined ? '' : `${key}=${emit(value)}`,
      });
    } else if (value !== undefined) {
      added.push(`${key}=${emit(value)}`);
    }
  }

  let head = open;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    head = head.slice(0, edit.from) + edit.text + head.slice(edit.to);
  }
  if (added.length) {
    // before the `/>` or `>`, which is the only place an attribute may go
    const close = selfClosing ? head.lastIndexOf('/') : head.lastIndexOf('>');
    head = `${head.slice(0, close).replace(/\s*$/, '')} ${added.join(' ')}${selfClosing ? ' ' : ''}${head.slice(close)}`;
  }
  // collapse the gap a removed attribute leaves, without touching anything else
  head = head.replace(/\s{2,}(?=[^\s])/g, ' ').replace(/\s+(\/?>)$/, selfClosing ? ' $1' : '$1');

  return selfClosing ? head : `${head}${tag.children}</${tag.name}>`;
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
