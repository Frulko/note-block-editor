export interface BlockSpec {
  type: string;
  version: number;
  /** Whether the block carries inline rich text (a `text` field). */
  inline: boolean;
  /** Structural container (columns, the page root): holds blocks, not content. */
  layout?: boolean;
  defaultProps?: Record<string, unknown>;
  /** Placeholder shown by the view when the block is empty and focused. */
  placeholder?: string;
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

// ponytail: no allowedChildren grammar yet — columns land with it (ARCHITECTURE §2.3)
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
  s.register(inline('code', { defaultProps: { language: 'plain' }, placeholder: 'Code' }));
  s.register(inline('callout', { defaultProps: { icon: '💡' }, placeholder: 'Callout' }));
  s.register({ type: 'divider', version: 1, inline: false });
  s.register({ type: 'image', version: 1, inline: false, defaultProps: { src: '', caption: '' } });
  s.register({ type: 'link_to_page', version: 1, inline: false, defaultProps: { pageId: '', title: '' } });
  s.register({ type: 'column_list', version: 1, inline: false, layout: true });
  s.register({ type: 'column', version: 1, inline: false, layout: true, defaultProps: {} });
  // the database VIEW BLOCK: placement of a collection view in a page (§2.5)
  s.register({ type: 'database', version: 1, inline: false, defaultProps: { collectionId: '', viewId: '' } });
  return s;
}
