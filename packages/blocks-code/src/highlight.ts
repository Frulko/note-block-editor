import { createLowlight } from 'lowlight';

/**
 * The tokenizer: code in, `(start, end, group)` triples out.
 *
 * Positions rather than HTML, because the live editor paints them with the CSS
 * Custom Highlight API and never touches the DOM — see
 * `docs/research/syntax-highlighting.md` for why that decides the whole
 * design. `lowlight` is highlight.js with a structured output instead of a
 * string, so one tokenizer serves both the editor and the static export.
 *
 * @module
 */

/**
 * The palette, not the grammar. highlight.js emits some fifty scopes; a code
 * block that used fifty colours would be unreadable, and a theme author would
 * have to name all of them. These nine are what editors actually colour, and
 * every scope maps onto one.
 */
export type TokenGroup =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'name'
  | 'type'
  | 'property'
  | 'operator'
  | 'meta';

export interface Token {
  start: number;
  end: number;
  group: TokenGroup;
}

/** hljs scope (minus its `hljs-` prefix) → palette group. Longest match wins. */
const GROUPS: Record<string, TokenGroup> = {
  keyword: 'keyword',
  literal: 'keyword',
  built_in: 'keyword',
  symbol: 'keyword',
  'selector-tag': 'keyword',
  string: 'string',
  regexp: 'string',
  'char.escape': 'string',
  formula: 'string',
  quote: 'string',
  'template-variable': 'string',
  subst: 'string',
  comment: 'comment',
  doctag: 'comment',
  number: 'number',
  title: 'name',
  'title.function': 'name',
  'title.function.invoke': 'name',
  name: 'name',
  section: 'name',
  bullet: 'name',
  link: 'name',
  type: 'type',
  class: 'type',
  'title.class': 'type',
  'title.class.inherited': 'type',
  'selector-class': 'type',
  'selector-id': 'type',
  tag: 'type',
  attr: 'property',
  attribute: 'property',
  property: 'property',
  variable: 'property',
  'variable.language': 'property',
  'variable.constant': 'property',
  params: 'property',
  'selector-attr': 'property',
  'selector-pseudo': 'property',
  operator: 'operator',
  punctuation: 'operator',
  meta: 'meta',
  'meta keyword': 'meta',
  'meta string': 'meta',
  'meta.prompt': 'meta',
  'template-tag': 'meta',
  addition: 'meta',
  deletion: 'meta',
  code: 'meta',
  emphasis: 'meta',
  strong: 'meta',
};

/**
 * Languages this block offers, by the id stored in `props.language` — which is
 * also what a markdown fence carries, so ` ```python ` and the picker agree.
 *
 * The loaders are literal dynamic imports rather than a computed specifier:
 * a bundler can only split what it can see, and this is what keeps a document
 * with one Python block from shipping the other twenty-five grammars.
 */
export const LANGUAGES: Array<{ id: string; label: string; load?: () => Promise<{ default: unknown }> }> = [
  { id: 'plain', label: 'Texte brut' },
  { id: 'bash', label: 'Bash', load: () => import('highlight.js/lib/languages/bash') },
  { id: 'c', label: 'C', load: () => import('highlight.js/lib/languages/c') },
  { id: 'cpp', label: 'C++', load: () => import('highlight.js/lib/languages/cpp') },
  { id: 'csharp', label: 'C#', load: () => import('highlight.js/lib/languages/csharp') },
  { id: 'css', label: 'CSS', load: () => import('highlight.js/lib/languages/css') },
  { id: 'diff', label: 'Diff', load: () => import('highlight.js/lib/languages/diff') },
  { id: 'dockerfile', label: 'Dockerfile', load: () => import('highlight.js/lib/languages/dockerfile') },
  { id: 'go', label: 'Go', load: () => import('highlight.js/lib/languages/go') },
  { id: 'graphql', label: 'GraphQL', load: () => import('highlight.js/lib/languages/graphql') },
  { id: 'html', label: 'HTML', load: () => import('highlight.js/lib/languages/xml') },
  { id: 'java', label: 'Java', load: () => import('highlight.js/lib/languages/java') },
  { id: 'javascript', label: 'JavaScript', load: () => import('highlight.js/lib/languages/javascript') },
  { id: 'json', label: 'JSON', load: () => import('highlight.js/lib/languages/json') },
  { id: 'kotlin', label: 'Kotlin', load: () => import('highlight.js/lib/languages/kotlin') },
  { id: 'lua', label: 'Lua', load: () => import('highlight.js/lib/languages/lua') },
  { id: 'markdown', label: 'Markdown', load: () => import('highlight.js/lib/languages/markdown') },
  // no grammar: a diagram is not read as code, and `@nbe/blocks-mermaid` draws
  // it. Listed so the language is reachable from the picker at all.
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'php', label: 'PHP', load: () => import('highlight.js/lib/languages/php') },
  { id: 'python', label: 'Python', load: () => import('highlight.js/lib/languages/python') },
  { id: 'ruby', label: 'Ruby', load: () => import('highlight.js/lib/languages/ruby') },
  { id: 'rust', label: 'Rust', load: () => import('highlight.js/lib/languages/rust') },
  { id: 'scss', label: 'SCSS', load: () => import('highlight.js/lib/languages/scss') },
  { id: 'shell', label: 'Shell', load: () => import('highlight.js/lib/languages/shell') },
  { id: 'sql', label: 'SQL', load: () => import('highlight.js/lib/languages/sql') },
  { id: 'swift', label: 'Swift', load: () => import('highlight.js/lib/languages/swift') },
  { id: 'toml', label: 'TOML', load: () => import('highlight.js/lib/languages/ini') },
  { id: 'typescript', label: 'TypeScript', load: () => import('highlight.js/lib/languages/typescript') },
  { id: 'xml', label: 'XML', load: () => import('highlight.js/lib/languages/xml') },
  { id: 'yaml', label: 'YAML', load: () => import('highlight.js/lib/languages/yaml') },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

/** The label a picker shows, falling back to the stored id for a stranger. */
export function languageLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

const lowlight = createLowlight();
const loading = new Map<string, Promise<void>>();

/** True when this language's grammar is in memory and `tokenize` can colour it. */
export function isLoaded(language: string): boolean {
  return lowlight.registered(language);
}

/**
 * Fetch a grammar, once. Resolves immediately for a language already loaded,
 * for `plain`, and for one we do not ship — the caller then gets uncoloured
 * text rather than an error, which is the right failure for a code block.
 */
/**
 * What people actually write in a fence, mapped to the grammar that answers it.
 *
 * @remarks
 * ` ```ts ` is what a TypeScript file's own README says, and it loaded
 * nothing: `BY_ID` is keyed by the id in {@link LANGUAGES}, so an alias found
 * no `load` and the block stayed grey. Only the load side needs this —
 * lowlight's own `registered()` already matches aliases, so tokenising starts
 * working the moment the real grammar is in memory.
 */
const ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cs: 'csharp',
  docker: 'dockerfile',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'shell',
};

/** The grammar id a fence's language name resolves to. */
export function resolveLanguage(language: string): string {
  const id = language.toLowerCase().trim();
  return ALIASES[id] ?? id;
}

export async function loadLanguage(name: string): Promise<void> {
  const language = resolveLanguage(name);
  if (language === 'plain' || isLoaded(language)) return;
  const spec = BY_ID.get(language);
  if (!spec?.load) return;
  let pending = loading.get(language);
  if (!pending) {
    pending = spec.load().then((mod) => {
      // a second caller may have won the race while this import was in flight
      if (!lowlight.registered(language)) lowlight.register(language, mod.default as never);
    });
    loading.set(language, pending);
  }
  await pending;
}

interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  properties?: { className?: string[] };
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string };

/**
 * Flatten highlight.js's tree into non-overlapping ranges.
 *
 * @remarks
 * Nested scopes (a substitution inside a template string, a doctag inside a
 * comment) resolve to the *innermost* one, so the ranges never overlap and the
 * painter does not have to reason about priority.
 */
function walk(node: HastNode, offset: number, group: TokenGroup | null, out: Token[]): number {
  if (node.type === 'text') {
    const { value } = node as HastText;
    if (group && value.length) out.push({ start: offset, end: offset + value.length, group });
    return offset + value.length;
  }
  if (node.type !== 'element') return offset;
  const element = node as HastElement;
  const scope = (element.properties?.className ?? [])
    .filter((c) => c.startsWith('hljs-'))
    .map((c) => c.slice(5))
    .find((c) => c in GROUPS);
  const inner = scope ? GROUPS[scope]! : group;
  let at = offset;
  for (const child of element.children) at = walk(child, at, inner, out);
  return at;
}

/**
 * Tokenize, synchronously, or return nothing.
 *
 * @remarks
 * Nothing is the honest answer for a grammar that is still loading or that we
 * do not ship: uncoloured code reads fine, whereas throwing or awaiting here
 * would put a network round trip in the keystroke path.
 */
export function tokenize(code: string, language: string): Token[] {
  if (!code || !isLoaded(language)) return [];
  const out: Token[] = [];
  try {
    const tree = lowlight.highlight(language, code) as unknown as HastElement;
    let at = 0;
    for (const child of tree.children) at = walk(child, at, null, out);
  } catch {
    return []; // a grammar can throw on pathological input; plain text is fine
  }
  return out;
}

/**
 * Guess the language of a snippet, among those already loaded.
 *
 * @remarks
 * Restricted to loaded grammars on purpose: highlight.js's detection scores a
 * candidate by running it, so an unrestricted call would pull every grammar we
 * ship into memory to answer a paste.
 */
export function detectLanguage(code: string): string | null {
  const subset = LANGUAGES.map((l) => l.id).filter((id) => isLoaded(id));
  if (!subset.length || code.trim().length < 12) return null;
  const result = lowlight.highlightAuto(code, { subset }) as { data?: { language?: string; relevance?: number } };
  const { language, relevance } = result.data ?? {};
  // highlight.js's own threshold for "this is a guess, not a match"
  return language && (relevance ?? 0) >= 5 ? language : null;
}
