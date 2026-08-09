import type { Block } from './types';

/**
 * The declarative description of a block type.
 *
 * @remarks
 * JSON-serializable apart from `migrations`, which is behaviour by necessity.
 * Everything else can be shipped to a server or a native port and consumed
 * without executing any JavaScript.
 *
 * @category Blocks
 */
export interface BlockSpec {
  type: string;
  version: number;
  /** Whether the block carries inline rich text (a `text` field). */
  inline: boolean;
  /** Structural container (columns, the page root): holds blocks, not content. */
  layout?: boolean;
  /**
   * Whether the hover gutter treats this block as a unit: something to grab,
   * drop beside, or open a menu on.
   *
   * @remarks
   * Defaults to "yes unless it is a layout container", which is right for
   * every built-in type and wrong for both ends of a table: the table *is* the
   * unit you move even though it is a container, and its rows and cells are
   * not, even though a cell carries text. Two exceptions used to be spelled
   * out by type name in `controls.ts`; declaring it here is what let the table
   * become a plugin.
   */
  standalone?: boolean;
  /**
   * The block's text is literal characters, not markup.
   *
   * @remarks
   * A code block holds what was typed and nothing else: `#` at the start of a
   * line is a comment, not a heading, and pasting a file into one must insert
   * the file. Two places used to test `type === 'code'` by name to get this
   * right — the autoformat gate and, by omission, nothing in the clipboard, so
   * pasting a shell script into a code block turned its comments into
   * headings. Declaring it is what let the code block become a plugin, the
   * same argument as {@link BlockSpec.standalone}.
   *
   * @defaultValue false
   */
  literal?: boolean;
  defaultProps?: Record<string, unknown>;
  /** Placeholder shown by the view when the block is empty and focused. */
  placeholder?: string;
  /**
   * One-step upgrades, keyed by the version each migrates *from*.
   *
   * @remarks
   * `migrations[1]` turns a v1 block into a v2 block, and nothing else.
   * Upgrading v1 to v4 runs three of these in order, so each step stays small
   * and independently testable. A version with no entry is treated as a
   * shape-preserving bump, which is the common case and does not deserve an
   * identity function.
   *
   * @example
   * ```ts
   * { type: 'callout', version: 2, inline: true,
   *   migrations: { 1: (b) => ({ ...b, props: { ...b.props, variant: 'note' } }) } }
   * ```
   */
  migrations?: Record<number, (block: Block) => Block>;
  /**
   * Extra checks this block type wants at apply time.
   *
   * @remarks
   * The built-in validation covers what the schema knows — inline versus void,
   * versions, tree consistency. Anything that depends on *props* lives here,
   * because `BlockSpec` deliberately has no prop type declaration and
   * inventing one would be a large speculative surface.
   *
   * @returns One message per problem. Empty means valid.
   *
   * @example
   * ```ts
   * validate: (b) => (typeof b.props.level === 'number' ? [] : ['level must be a number'])
   * ```
   */
  validate?: (block: Block) => string[];
}

/**
 * Three kinds of block, and every behavioural question follows from which one
 * you have:
 * - `text`   carries inline content, so it owns a caret and is edited
 * - `void`   has no text (image, divider, page link, database): there is no
 *            caret to place, so a press on it is a grab, not an edit
 * - `layout` is structure (columns, page): never a drag target of its own
 */
export type BlockCategory = 'text' | 'void' | 'layout';

export function blockCategory(schema: Schema, type: string): BlockCategory {
  if (!schema.has(type)) return 'text';
  const spec = schema.get(type);
  if (spec.layout) return 'layout';
  return spec.inline ? 'text' : 'void';
}

export class Schema {
  private specs = new Map<string, BlockSpec>();

  register(spec: BlockSpec): this {
    this.specs.set(spec.type, spec);
    return this;
  }

  get(type: string): BlockSpec {
    const spec = this.specs.get(type);
    if (!spec) throw new Error(`Unknown block type: ${type}`);
    return spec;
  }

  has(type: string): boolean {
    return this.specs.has(type);
  }
}

/*
 * ponytail: still no `allowedChildren` grammar. The note used to say "columns
 * land with it"; they landed and it did not, so what the gap permits is now
 * measured rather than deferred (`test/grammar.test.ts`).
 *
 * **Types are validated at apply; relationships are not.** An unknown block
 * type is rejected, and a `column` parented straight to the page is accepted —
 * a document §2.3 does not describe and the wrapper normaliser does not expect.
 * Not currently harmful, because nothing constructs one. Recorded because the
 * architecture says validation happens at apply, and a reader would take that
 * to include structure.
 *
 * The upgrade path is a per-spec `allowedChildren` checked in `validate.ts`
 * alongside the type check, which is one place rather than a new pass.
 */
export function baseSchema(): Schema {
  const s = new Schema();
  const inline = (type: string, extra?: Partial<BlockSpec>): BlockSpec => ({
    type,
    version: 1,
    inline: true,
    ...extra,
  });
  s.register({ type: 'page', version: 1, inline: false, layout: true });
  s.register(inline('paragraph'));
  s.register(inline('heading', { defaultProps: { level: 1 }, placeholder: 'Heading' }));
  s.register(inline('bulleted_list_item', { placeholder: 'List' }));
  s.register(inline('numbered_list_item', { placeholder: 'List' }));
  s.register(inline('to_do', { defaultProps: { checked: false }, placeholder: 'To-do' }));
  s.register(inline('toggle', { defaultProps: { collapsed: false }, placeholder: 'Toggle' }));
  s.register(inline('quote', { placeholder: 'Quote' }));
  s.register(inline('callout', { defaultProps: { icon: '💡' }, placeholder: 'Callout' }));
  s.register({ type: 'divider', version: 1, inline: false });
  s.register({ type: 'image', version: 1, inline: false, defaultProps: { src: '', caption: '' } });
  s.register({ type: 'link_to_page', version: 1, inline: false, defaultProps: { pageId: '', title: '' } });
  // a sub-page: the child page *lives* here, where a link_to_page only points
  // at it. The workspace tree is derived from these (@nbe/workspace).
  s.register({ type: 'sub_page', version: 1, inline: false, defaultProps: { pageId: '', title: '' } });
  s.register({ type: 'column_list', version: 1, inline: false, layout: true });
  s.register({ type: 'column', version: 1, inline: false, layout: true, defaultProps: {} });
  // the database VIEW BLOCK: placement of a collection view in a page (§2.5)
  s.register({ type: 'database', version: 1, inline: false, defaultProps: { collectionId: '', viewId: '' } });
  return s;
}
