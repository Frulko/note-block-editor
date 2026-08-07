import type { Block } from './types';
import type { BlockSpec } from './schema';

/**
 * The block plugin contract.
 *
 * This type is declared *whole* — schema, view and every projection — before
 * any of it is wired up, and that ordering is deliberate. The failure it
 * prevents is Lexical's: a node there is registered in three unsynchronised
 * places (`exportJSON` on the class, `exportDOM` on the class, and markdown
 * transformers passed at the call site and not on the class at all), so a node
 * can render perfectly and vanish from a markdown export with nothing able to
 * notice. Tiptap has the same shape of hole from the other direction —
 * bidirectional markdown arrived years after the extension API froze, so every
 * extension written before it has no handler, and its own table cells turn
 * `foo<br>bar` into `foo bar` with no error.
 *
 * One type, one registration, every output. Wired up in stages; declared once.
 *
 * @see docs/research/plugin-architecture.md
 */

/**
 * Where a contribution sits relative to others of its kind.
 *
 * Named categories, not numbers, and this is the single most evidence-backed
 * decision in the plugin design. A module in isolation cannot know what
 * numbers other modules picked — they are points on an undifferentiated range,
 * i.e. z-index. Lexical shipped five numeric buckets, found you could not get
 * in front of a listener at your own level, and had to add negative constants
 * that bit-mask back into the same bucket. Tiptap shipped its ordering
 * backwards for a long time and nobody noticed, because the resulting order is
 * unobservable.
 *
 * Within a category, registration order decides. That is observable in the
 * array the host wrote.
 */
export type Precedence = 'highest' | 'high' | 'default' | 'low' | 'lowest';

export const PRECEDENCE_ORDER: readonly Precedence[] = ['highest', 'high', 'default', 'low', 'lowest'];

/** A value with a precedence attached. `at()` is how you tag one. */
export interface Ranked<T> {
  precedence: Precedence;
  value: T;
}

/**
 * Tag a contribution with a precedence.
 *
 * Per-contribution rather than per-plugin, which is the fix for the other
 * documented failure: Tiptap's single `priority` governs keymaps *and* input
 * rules *and* paste rules *and* rendering at once, so a block that needs to
 * win the keyboard but lose the input rule cannot say so.
 */
export function at<T>(precedence: Precedence, value: T): Ranked<T> {
  return { precedence, value };
}

/** Sort ranked contributions: category first, then registration order. */
export function byPrecedence<T>(items: Array<Ranked<T> | T>): T[] {
  const ranked = items.map((item, index) =>
    isRanked(item) ? { ...item, index } : { precedence: 'default' as Precedence, value: item, index },
  );
  return ranked
    .sort(
      (a, b) =>
        PRECEDENCE_ORDER.indexOf(a.precedence) - PRECEDENCE_ORDER.indexOf(b.precedence) || a.index - b.index,
    )
    .map((r) => r.value);
}

function isRanked<T>(item: Ranked<T> | T): item is Ranked<T> {
  return (
    typeof item === 'object' &&
    item !== null &&
    'precedence' in item &&
    'value' in item &&
    PRECEDENCE_ORDER.includes((item as Ranked<T>).precedence)
  );
}

/**
 * How a block becomes markdown and comes back.
 *
 * Both directions are required, and that is the point. A plugin author who
 * only implements `toMarkdown` has written a block that silently degrades on
 * re-import; the type refuses it. When a format genuinely cannot represent a
 * block, say so with {@link lossy} rather than omitting the handler.
 */
export interface MarkdownProjection {
  /** Serialize. Return the lines this block occupies. */
  toMarkdown(block: Block, ctx: ProjectionContext): string[];
  /**
   * Recognise this block in markdown. Consulted in precedence order, and the
   * first matching rule wins.
   */
  fromMarkdown: MarkdownRule[];
  /**
   * Set when this format cannot represent the block faithfully. Read by
   * tooling and by the docs table — never at runtime — so the loss is
   * discoverable instead of discovered.
   */
  lossyReason?: string;
}

export interface MarkdownRule {
  /** Tested against the first line of a candidate block. */
  match: RegExp;
  /** Parse from `lines[start]`; return the block and how many lines it ate. */
  parse(lines: string[], start: number): { block: Block; consumed: number } | null;
}

export interface ProjectionContext {
  /** Render a child block, so a container does not re-implement the walk. */
  child(block: Block): string[];
  /** Indentation depth, for nested structures. */
  depth: number;
}

/**
 * Declare that a format cannot represent this block faithfully.
 *
 * The alternative — omitting the handler — is what produces silent loss, and
 * silent loss on export is the one failure this project exists to prevent. A
 * lossy projection still round-trips *something*, and says what it dropped.
 */
export function lossy(reason: string, fallback: (block: Block) => string[]): MarkdownProjection {
  return { toMarkdown: (block) => fallback(block), fromMarkdown: [], lossyReason: reason };
}

/**
 * A block plugin: one declaration covering every surface a block touches.
 *
 * `schema` is JSON-serializable and free of behaviour on purpose — the static
 * renderer and a future Swift port consume it without executing any
 * JavaScript. Everything else is behaviour and lives beside it rather than
 * inside it.
 */
export interface BlockPlugin {
  /**
   * The contract version this plugin was written against, checked at
   * registration. Three lines that let v1 and v2 plugins run side by side
   * during a migration, instead of a flag day where every author breaks at
   * once.
   */
  apiVersion: 1;
  schema: BlockSpec;
  /**
   * Editing-surface behaviour. Lives in the `@nbe/dom` layer, so it is typed
   * as unknown here and refined there — `core` must never depend on the DOM.
   */
  view?: unknown;
  markdown?: MarkdownProjection;
  /** Static HTML for export and SSR. Returns a spec tree, never live DOM. */
  html?: (block: Block, ctx: ProjectionContext) => string;
}

/** Thrown when a plugin declares a contract version this build cannot honour. */
export class PluginVersionError extends Error {
  constructor(type: string, got: number) {
    super(`Block plugin "${type}" targets plugin API v${got}; this build implements v1.`);
    this.name = 'PluginVersionError';
  }
}

export const PLUGIN_API_VERSION = 1;

/**
 * Per-editor, never module-global.
 *
 * ProseMirror's module-level `PluginKey` produces a long-running class of
 * failure — "Adding different instances of a keyed plugin" — whenever two
 * copies of a package load, and our own `block-actions.ts` and
 * `block-toolbar.ts` are the same mistake in miniature: two editors on one
 * page share their registries today. Module-level *keys* are fine; module-level
 * *values* are not.
 */
export class PluginRegistry {
  private byType = new Map<string, BlockPlugin>();

  register(plugin: BlockPlugin): this {
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      throw new PluginVersionError(plugin.schema.type, plugin.apiVersion);
    }
    this.byType.set(plugin.schema.type, plugin);
    return this;
  }

  registerAll(plugins: readonly BlockPlugin[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  get(type: string): BlockPlugin | undefined {
    return this.byType.get(type);
  }

  has(type: string): boolean {
    return this.byType.has(type);
  }

  types(): string[] {
    return [...this.byType.keys()];
  }

  /** Every registered plugin, for building the schema or a projection table. */
  all(): BlockPlugin[] {
    return [...this.byType.values()];
  }
}
