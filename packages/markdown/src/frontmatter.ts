/**
 * The YAML map at the top of a Markdown file — where everything that is *about*
 * the document goes, so nothing that is not prose has to live in the prose.
 *
 * @remarks
 * Frontmatter is the one convention every Markdown tool already agrees on:
 * three dashes, a YAML map, three dashes, at the very top of the file. Obsidian
 * shows it as properties, Jekyll, Hugo, Astro and Zola read it as metadata, and
 * a plain text editor shows it as five legible lines. So it is where this
 * editor keeps what a line of Markdown cannot say about the *document* — the
 * same bargain `<!-- nbe:type -->` trailers make about a *block*.
 *
 * Two rules make it safe to write into a file someone else also writes into:
 *
 * 1. **A key we did not touch is re-emitted verbatim.** Not re-serialized from
 *    a parsed value — copied, byte for byte, comments and block sequences and
 *    hand alignment included. Anything else means opening a note and closing it
 *    leaves a diff on somebody's `tags:` list, which is the one thing this
 *    project promises not to do.
 * 2. **Everything this editor owns hangs under one key**, {@link APP_SECTION}.
 *    A vault's own `title`, `tags` or `cssclasses` can never collide with ours,
 *    and two plugins writing to the frontmatter cannot clobber each other:
 *    {@link Frontmatter.setSection} merges into the map rather than replacing
 *    it, so `nbe.comments` and `nbe.whatever-you-add-next` coexist.
 *
 * Structured values are written in YAML's flow style, which is JSON — valid
 * YAML by definition, read correctly by every parser, and read back here with
 * `JSON.parse` rather than a YAML implementation this package would have to
 * carry. What we write, we can always read; what a person wrote by hand, we
 * keep.
 *
 * @example
 * ```md
 * ---
 * title: Réunion : 2026/07
 * tags:
 *   - projet
 * nbe: {"comments":[{"id":"t1","blockId":"b3","messages":[…]}]}
 * ---
 * ```
 *
 * @module
 */

/**
 * The key every piece of editor-owned data hangs under.
 *
 * @remarks
 * The same prefix the block trailers use (`<!-- nbe:type -->`), for the same
 * reason: one name to recognise, one name to strip if this editor is ever left
 * behind.
 *
 * @category Projections
 */
export const APP_SECTION = 'nbe';

/** A parsed key, plus the source it came from when nothing has changed it. */
interface Entry {
  /** The verbatim lines, kept so an untouched key is re-emitted unchanged. */
  raw?: string;
  value: unknown;
}

/** `key: value`, at the top level of the map. */
const KEY = /^([^#\s][^:]*):(?:[ \t]+(.*))?$/;

/** A line that continues the key above it: indented, or a sequence item. */
const CONTINUATION = /^(?:[ \t]+\S|-[ \t])/;

/** Plain-scalar characters: no YAML punctuation, so no quoting needed. */
const PLAIN = /^[\w./\- àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ']+$/;

/**
 * A YAML scalar, as the value it means.
 *
 * @remarks
 * Quoted strings, booleans, numbers, `null`, and JSON flow values — which is
 * everything this package writes and the great majority of what a person types.
 * Anything else comes back as the trimmed source text, which is both harmless
 * and reversible: the key it belongs to is re-emitted from its raw lines.
 *
 * @category Projections
 */
export function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return unquote(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      return s; // a flow value we cannot read is still text somebody typed
    }
  }
  return s;
}

/** Take the quotes off a YAML string, keeping what is inside them. */
export function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1)}"` : s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * A value as YAML: a plain scalar where that is unambiguous, JSON otherwise.
 *
 * @remarks
 * The test for "unambiguous" is the parser above: a string is written plain
 * only when reading it back gives that same string. `42`, `true` and `2026/07`
 * are strings a user may well have typed, and each of them means something
 * else unquoted — so each of them gets quotes.
 *
 * @category Projections
 */
export function emitScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  const plain = PLAIN.test(text) && text.trim() === text && typeof parseScalar(text) === 'string';
  return plain ? text : JSON.stringify(text);
}

/** A scalar, or — for a map or a list — JSON, which is YAML's flow style. */
function emitValue(value: unknown): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : emitScalar(value);
}

/**
 * The frontmatter of one file: a small ordered map that remembers its source.
 *
 * @remarks
 * Ordered because a file is read by people: keys come back out in the order
 * they went in, and a key set for the first time is appended at the end rather
 * than sorted into the middle of someone's header.
 *
 * @category Projections
 */
export class Frontmatter {
  private readonly entries = new Map<string, Entry>();
  /** Lines after the last key — a trailing comment, usually. */
  private trailing = '';

  /**
   * Read a frontmatter block: the text *between* the two `---` lines.
   *
   * @remarks
   * A multi-line value (a block sequence, a nested map) is kept as its source
   * lines and *also* read, one level deep, into a list or a map of scalars — so
   * `tags:` with three items under it is both readable here and untouched in
   * the file. A shape this does not recognise is still carried; only its value
   * is missing, and no caller has ever asked for one.
   */
  static parse(source: string): Frontmatter {
    const fm = new Frontmatter();
    // the header is kept in LF, as `blocksToMarkdown` writes the prose: a CRLF
    // file loses its returns whichever half of it is rewritten, and half a file
    // in each convention is worse than either
    const lines = source.split(/\r?\n/);
    let key: string | null = null;
    let chunk: string[] = [];
    const flush = (): void => {
      if (key === null) return;
      const [head, ...rest] = chunk;
      const inline = KEY.exec(head!)![2] ?? '';
      fm.entries.set(key, {
        raw: chunk.join('\n'),
        value: rest.length ? nested(rest) : parseScalar(inline),
      });
      key = null;
      chunk = [];
    };
    for (const line of lines) {
      if (key !== null && (CONTINUATION.test(line) || !line.trim())) {
        chunk.push(line);
        continue;
      }
      const m = KEY.exec(line);
      if (m) {
        flush();
        key = m[1]!.trim();
        chunk = [line];
        continue;
      }
      // a comment or a line no rule claims: it travels with the key above it,
      // or trails the block when there is none
      if (key !== null) chunk.push(line);
      else fm.trailing += (fm.trailing ? '\n' : '') + line;
    }
    flush();
    return fm;
  }

  /** The value of a key, or `undefined` when the file does not carry it. */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : (entry.value as T);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Every key, in file order. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Set a key — or, with `undefined`, remove it.
   *
   * @remarks
   * A key set this way loses its verbatim source, which is the point: it is the
   * one key we are changing. Every other key still comes back out byte for byte.
   */
  set(key: string, value: unknown): this {
    if (value === undefined) this.entries.delete(key);
    else this.entries.set(key, { value });
    return this;
  }

  /**
   * Read one section of the editor's own map — `nbe.comments`, or whatever a
   * plugin decided to call its own.
   *
   * @typeParam T - What the section holds. Unchecked: the file is text, and a
   * hand-edited one may hold anything, so treat the result as untrusted input.
   */
  section<T = unknown>(name: string): T | undefined {
    return this.get<Record<string, unknown>>(APP_SECTION)?.[name] as T | undefined;
  }

  /**
   * Write one section, merging into whatever else lives under {@link APP_SECTION}.
   *
   * @remarks
   * The merge is the whole contract: a plugin writes its own key and cannot
   * lose another's. `undefined` removes the section, and removing the last one
   * removes `nbe:` itself — a note with nothing to remember carries no trace of
   * this editor at all.
   */
  setSection(name: string, value: unknown): this {
    const own = { ...(this.get<Record<string, unknown>>(APP_SECTION) ?? {}) };
    if (value === undefined) delete own[name];
    else own[name] = value;
    return this.set(APP_SECTION, Object.keys(own).length ? own : undefined);
  }

  /** True when there is nothing to write. */
  get empty(): boolean {
    return this.entries.size === 0 && !this.trailing;
  }

  /** The block, fences included — or `''` when there is nothing to fence. */
  toString(): string {
    if (this.empty) return '';
    const lines: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.raw !== undefined) {
        lines.push(entry.raw);
        continue;
      }
      const value = emitValue(entry.value);
      lines.push(value ? `${key}: ${value}` : `${key}:`);
    }
    if (this.trailing) lines.push(this.trailing);
    return `---\n${lines.join('\n')}\n---\n`;
  }
}

/** A block sequence or a nested map, one level deep, as a value. */
function nested(lines: string[]): unknown {
  const kept = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!kept.length) return null;
  if (kept.every((l) => /^\s*-\s/.test(l))) return kept.map((l) => parseScalar(l.replace(/^\s*-\s/, '')));
  const map: Record<string, unknown> = {};
  for (const line of kept) {
    const m = KEY.exec(line.trim());
    if (!m) return undefined; // a shape we do not read; the raw lines still carry it
    map[m[1]!.trim()] = parseScalar(m[2] ?? '');
  }
  return map;
}

/** A file's frontmatter and the Markdown under it. */
export interface FrontmatterSplit {
  frontmatter: Frontmatter;
  /**
   * Everything after the closing `---`, untouched — the blank line that usually
   * follows it included, so writing the file back is byte-exact.
   */
  body: string;
}

const FENCE = /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/;

/**
 * Split a Markdown file into its frontmatter and its prose.
 *
 * @remarks
 * A file with no frontmatter — or with a `---` that is a divider rather than a
 * fence, i.e. anywhere but the first line — comes back whole, with an empty
 * map. Nothing is a fence unless it opens the file, which is the rule every
 * other tool applies too.
 *
 * @category Projections
 */
export function readFrontmatter(text: string): FrontmatterSplit {
  const m = FENCE.exec(text);
  if (!m) return { frontmatter: new Frontmatter(), body: text };
  return { frontmatter: Frontmatter.parse(m[1]!.replace(/\r?\n$/, '')), body: text.slice(m[0].length) };
}

/**
 * Put a file back together.
 *
 * @remarks
 * Exactly `frontmatter + body`, with no blank line inserted between them: a
 * vault writes the two tight against each other, and adding a line here would
 * mean every note in it grew a diff the first time it was opened.
 *
 * @category Projections
 */
export function writeFrontmatter(frontmatter: Frontmatter, body: string): string {
  return frontmatter.toString() + body;
}
