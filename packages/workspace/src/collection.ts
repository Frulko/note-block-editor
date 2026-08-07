import { uuidv7, type BlockJSON, type CollectionSchema, type PropertyDef, type PropertyType, type ViewConfig } from '@nbe/core';

/**
 * A CSV table as a real collection — schema, view, and rows as pages.
 *
 * @remarks
 * §2.5 models a database as **four separate records**, so that linked views
 * and several views over one source cost nothing later: a view *block* places
 * it in a page, a *view* holds layout and filters, a *schema* holds typed
 * properties, and the *rows* are ordinary pages. A Notion export gives us a
 * CSV, which is rows and column names and nothing else — so the schema has to
 * be inferred.
 *
 * **Inference is the risky part, and it is deliberately timid.** A column
 * becomes a typed property only when *every* non-empty value in it fits, and
 * otherwise stays text. Text is always readable and always editable; a wrong
 * type hides values, breaks sorting, and is discovered weeks later. The rules:
 *
 * - **number** — every value parses as one, and at least one row is non-empty.
 * - **checkbox** — every value is yes/no, true/false, ✓, or their French forms.
 * - **date** — every value parses as a date *and* looks like one, so that a
 *   column of years is not silently turned into January the first.
 * - **url** — every value starts with a scheme.
 * - **select** — few distinct values across many rows, which is what a status
 *   column looks like and what a name column never does.
 * - **text** — everything else, including anything ambiguous.
 *
 * `inferred: true` is recorded on the schema so an app can say where the
 * types came from, rather than presenting a guess as a declaration.
 *
 * @category Storage
 */

/** The result of reading one CSV: everything §2.5 keeps apart. */
export interface ImportedCollection {
  schema: CollectionSchema & { inferred?: boolean };
  view: ViewConfig;
  /** One page per row, carrying `collectionId` and `properties`. */
  rows: BlockJSON[];
  /** The block to place in a page so the collection is shown. */
  viewBlock: BlockJSON;
}

const TRUE_WORDS = new Set(['yes', 'true', 'oui', 'vrai', 'x', '✓', '1']);
const FALSE_WORDS = new Set(['no', 'false', 'non', 'faux', '0', '']);

/** Looks like a date rather than merely parsing as one. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;

function inferType(values: string[]): { type: PropertyType; options?: string[] } {
  const filled = values.filter((v) => v.trim());
  if (!filled.length) return { type: 'text' };

  if (filled.every((v) => v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))))) {
    return { type: 'number' };
  }
  if (values.every((v) => TRUE_WORDS.has(v.trim().toLowerCase()) || FALSE_WORDS.has(v.trim().toLowerCase()))) {
    return { type: 'checkbox' };
  }
  if (filled.every((v) => DATE_SHAPE.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())))) {
    return { type: 'date' };
  }
  if (filled.every((v) => /^[a-z][\w+.-]*:\/\//i.test(v.trim()))) {
    return { type: 'url' };
  }

  const distinct = [...new Set(filled.map((v) => v.trim()))];
  // a status column repeats itself; a name column does not
  if (filled.length >= 4 && distinct.length <= Math.min(8, filled.length / 2)) {
    return { type: 'select', options: distinct };
  }
  return { type: 'text' };
}

/** Coerce a cell to the value its property type expects. */
function coerce(raw: string, type: PropertyType): unknown {
  const value = raw.trim();
  if (!value) return type === 'checkbox' ? false : '';
  switch (type) {
    case 'number':
      return Number(value.replace(',', '.'));
    case 'checkbox':
      return TRUE_WORDS.has(value.toLowerCase());
    default:
      return value;
  }
}

/**
 * Build a collection from parsed CSV rows.
 *
 * @param name - What to call it, usually the CSV's filename.
 * @param rows - The header row first, then the data rows.
 * @returns `null` when there is no header to work from.
 */
export function collectionFromRows(name: string, rows: string[][]): ImportedCollection | null {
  const header = rows[0];
  if (!header?.length) return null;
  const body = rows.slice(1);

  /*
   * Notion puts the row's title in the first column, and our model keeps the
   * title on the row *page* rather than as a property — so the first column
   * becomes the page title and only the rest become properties.
   */
  const [titleColumn, ...propertyColumns] = header;
  const properties: PropertyDef[] = propertyColumns.map((columnName, index) => {
    const values = body.map((row) => row[index + 1] ?? '');
    const { type, options } = inferType(values);
    return {
      id: uuidv7(),
      name: columnName || `Colonne ${index + 2}`,
      type,
      ...(options ? { options } : {}),
    };
  });

  const schema: CollectionSchema & { inferred?: boolean } = {
    id: uuidv7(),
    name: name || titleColumn || 'Base',
    properties,
    inferred: true,
  };
  const view: ViewConfig = { id: uuidv7(), layout: 'table', filters: [], sorts: [] };

  const pages: BlockJSON[] = body.map((row) => {
    const title = (row[0] ?? '').trim();
    const values: Record<string, unknown> = {};
    properties.forEach((property, index) => {
      values[property.id] = coerce(row[index + 1] ?? '', property.type);
    });
    return {
      id: uuidv7(),
      type: 'page',
      version: 1,
      props: { title, collectionId: schema.id, properties: values },
      children: [
        { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: title ? [{ text: title }] : [] },
      ],
    };
  });

  return {
    schema,
    view,
    rows: pages,
    viewBlock: {
      id: uuidv7(),
      type: 'database',
      version: 1,
      props: { collectionId: schema.id, viewId: view.id },
    },
  };
}
