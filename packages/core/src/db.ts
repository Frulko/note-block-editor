/**
 * Database model (ARCHITECTURE §2.5, phase 3): the four record kinds.
 * - the `database` BLOCK (schema.ts) is the placement in a page (view block)
 * - CollectionSchema (typed properties) and ViewConfig (layout/filter/sort)
 *   are workspace-level records owned by the host
 * - rows are ordinary pages whose props carry { collectionId, properties }
 * This module is the pure evaluation engine; rendering lives in @nbe/dom and
 * storage in the host. Formulas, relations and rollups are evaluated here:
 * `computeRow` resolves them before any filter, sort or grouping runs, so a
 * computed column behaves like any other (AQ#8).
 */

export type PropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'formula'
  | 'relation'
  | 'rollup';

export type RollupFn = 'count' | 'sum' | 'average' | 'min' | 'max' | 'show';

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  /** select / multi_select choices */
  options?: string[];
  /** formula: source text, evaluated against the row (see formula.ts) */
  formula?: string;
  /** relation: which collection this property points into */
  relation?: { collectionId: string };
  /** rollup: aggregate a target property across a relation's rows */
  rollup?: { relationPropertyId: string; targetPropertyId: string; fn: RollupFn };
}

/** Property types whose value is derived, never authored. */
export const COMPUTED_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>(['formula', 'rollup']);

export interface CollectionSchema {
  id: string;
  name: string;
  properties: PropertyDef[];
}

import { evaluateFormula, type FormulaValue } from './formula';

export type FilterOp = 'eq' | 'neq' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt';

export interface Filter {
  /** property id, or 'title' for the row page title */
  propertyId: string;
  op: FilterOp;
  value?: unknown;
}

export interface Sort {
  propertyId: string;
  dir: 'asc' | 'desc';
}

export type ViewLayout = 'table' | 'board' | 'list' | 'gallery';

export interface ViewConfig {
  id: string;
  layout: ViewLayout;
  filters: Filter[];
  sorts: Sort[];
  /** Property to group by (board columns / table sections). */
  groupBy?: string;
  /** Property ids hidden in this view. */
  hidden?: string[];
}

export interface RowData {
  pageId: string;
  title: string;
  properties: Record<string, unknown>;
}

export const PROPERTY_TYPES: Array<{ type: PropertyType; label: string }> = [
  { type: 'text', label: 'Texte' },
  { type: 'number', label: 'Nombre' },
  { type: 'select', label: 'Sélection' },
  { type: 'multi_select', label: 'Multi-sélection' },
  { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Case à cocher' },
  { type: 'url', label: 'URL' },
  { type: 'formula', label: 'Formule' },
  { type: 'relation', label: 'Relation' },
  { type: 'rollup', label: 'Rollup' },
];

export const ROLLUP_FNS: Array<{ fn: RollupFn; label: string }> = [
  { fn: 'count', label: 'Nombre' },
  { fn: 'sum', label: 'Somme' },
  { fn: 'average', label: 'Moyenne' },
  { fn: 'min', label: 'Minimum' },
  { fn: 'max', label: 'Maximum' },
  { fn: 'show', label: 'Afficher les valeurs' },
];

function rawValue(row: RowData, propertyId: string): unknown {
  return propertyId === 'title' ? row.title : row.properties[propertyId];
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function asComparable(v: unknown, type: PropertyType | 'title'): number | string {
  if (type === 'number') return typeof v === 'number' ? v : Number(v ?? NaN);
  if (type === 'date') {
    const t = Date.parse(String(v ?? ''));
    return Number.isNaN(t) ? NaN : t;
  }
  if (type === 'checkbox') return v ? 1 : 0;
  if (Array.isArray(v)) return v.join(', ').toLowerCase();
  return String(v ?? '').toLowerCase();
}

function propType(schema: CollectionSchema, propertyId: string): PropertyType | 'title' {
  if (propertyId === 'title') return 'title';
  return schema.properties.find((p) => p.id === propertyId)?.type ?? 'text';
}

export function matchesFilter(row: RowData, filter: Filter, schema: CollectionSchema): boolean {
  const v = rawValue(row, filter.propertyId);
  const type = propType(schema, filter.propertyId);
  switch (filter.op) {
    case 'empty':
      return isEmptyValue(v);
    case 'not_empty':
      return !isEmptyValue(v);
    case 'eq':
    case 'neq': {
      const equal = Array.isArray(v)
        ? v.map(String).includes(String(filter.value))
        : asComparable(v, type) === asComparable(filter.value, type);
      return filter.op === 'eq' ? equal : !equal;
    }
    case 'contains': {
      if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase()).includes(String(filter.value).toLowerCase());
      return String(v ?? '').toLowerCase().includes(String(filter.value ?? '').toLowerCase());
    }
    case 'gt':
    case 'lt': {
      const a = asComparable(v, type);
      const b = asComparable(filter.value, type);
      if (typeof a === 'number' && typeof b === 'number') {
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        return filter.op === 'gt' ? a > b : a < b;
      }
      return filter.op === 'gt' ? String(a) > String(b) : String(a) < String(b);
    }
  }
}

export function compareRows(a: RowData, b: RowData, sort: Sort, schema: CollectionSchema): number {
  const type = propType(schema, sort.propertyId);
  const va = rawValue(a, sort.propertyId);
  const vb = rawValue(b, sort.propertyId);
  // missing values always sort last, regardless of direction
  const ea = isEmptyValue(va);
  const eb = isEmptyValue(vb);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  const ca = asComparable(va, type);
  const cb = asComparable(vb, type);
  let cmp: number;
  if (typeof ca === 'number' && typeof cb === 'number') {
    if (Number.isNaN(ca) || Number.isNaN(cb)) cmp = Number.isNaN(ca) === Number.isNaN(cb) ? 0 : Number.isNaN(ca) ? 1 : -1;
    else cmp = ca - cb;
  } else {
    cmp = String(ca).localeCompare(String(cb));
  }
  return sort.dir === 'asc' ? cmp : -cmp;
}

/** Pure view evaluation: filters (AND) then stable multi-sort. */
export function applyView(rows: RowData[], view: ViewConfig, schema: CollectionSchema): RowData[] {
  const filtered = rows.filter((r) => view.filters.every((f) => matchesFilter(r, f, schema)));
  const out = [...filtered];
  for (const sort of [...view.sorts].reverse()) {
    // stable sort per key, applied minor-to-major
    out.sort((a, b) => compareRows(a, b, sort, schema));
  }
  return out;
}

// ------------------------------------------------- computed values (AQ#8)

export interface ComputeContext {
  /** Rows of a related collection (for relations and rollups). */
  relatedRows?: (collectionId: string) => RowData[];
  /** Schema of a related collection, to resolve rollup targets. */
  relatedSchema?: (collectionId: string) => CollectionSchema | null;
}

const CYCLE = Symbol('formula-cycle');

/**
 * Resolve a row's derived properties (formula, rollup). Authored values pass
 * through untouched. Formulas may reference other formulas; a cycle resolves
 * to null instead of hanging — one bad formula must never take a table down.
 */
export function computeRow(
  row: RowData,
  schema: CollectionSchema,
  ctx: ComputeContext = {},
): Record<string, unknown> {
  const byName = new Map(schema.properties.map((p) => [p.name, p]));
  const cache = new Map<string, unknown>();
  const visiting = new Set<string>();

  const valueOfProp = (prop: PropertyDef): unknown => {
    if (cache.has(prop.id)) {
      const cached = cache.get(prop.id);
      return cached === CYCLE ? null : cached;
    }
    if (visiting.has(prop.id)) return null; // cycle
    visiting.add(prop.id);
    let value: unknown;
    if (prop.type === 'formula') {
      value = prop.formula
        ? evaluateFormula(prop.formula, {
            prop: (name) => {
              if (name === 'Titre' || name === 'Title') return row.title;
              const target = byName.get(name);
              return target ? (valueOfProp(target) as FormulaValue) : null;
            },
          })
        : null;
    } else if (prop.type === 'rollup') {
      value = computeRollup(row, prop, schema, ctx);
    } else {
      value = row.properties[prop.id];
    }
    visiting.delete(prop.id);
    cache.set(prop.id, value);
    return value;
  };

  const out: Record<string, unknown> = { ...row.properties };
  for (const prop of schema.properties) {
    if (COMPUTED_TYPES.has(prop.type)) out[prop.id] = valueOfProp(prop);
  }
  return out;
}

function computeRollup(
  row: RowData,
  prop: PropertyDef,
  schema: CollectionSchema,
  ctx: ComputeContext,
): unknown {
  const config = prop.rollup;
  if (!config) return null;
  const ids = relationIds(row, config.relationPropertyId);
  if (config.fn === 'count') return ids.length; // count works without resolving rows
  if (!ids.length || !ctx.relatedRows || !ctx.relatedSchema) return null;

  // the relation property (same schema) declares the collection we point into
  const relationProp = schema.properties.find((p) => p.id === config.relationPropertyId);
  const collectionId = relationProp?.relation?.collectionId;
  if (!collectionId) return null;

  const targetSchema = ctx.relatedSchema(collectionId);
  const target = targetSchema?.properties.find((p) => p.id === config.targetPropertyId);
  const values = ctx
    .relatedRows(collectionId)
    .filter((r) => ids.includes(r.pageId))
    .map((r) => (config.targetPropertyId === 'title' ? r.title : r.properties[config.targetPropertyId]));

  if (config.fn === 'show') {
    return values.filter((v) => !isEmptyValue(v)).map((v) => formatValue(v, target?.type ?? 'text'));
  }
  const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  switch (config.fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'average':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    default:
      return Math.max(...nums);
  }
}

/** Relation values are stored as an array of related page ids. */
export function relationIds(row: RowData, relationPropertyId: string): string[] {
  const raw = row.properties[relationPropertyId];
  return Array.isArray(raw) ? raw.map(String) : [];
}

export interface RowGroup {
  /** Stable group key ('' for the no-value group). */
  key: string;
  label: string;
  rows: RowData[];
}

export const EMPTY_GROUP_LABEL = 'Sans valeur';

/**
 * Group rows by a property. Group order follows the property's declared
 * options (so board columns keep the schema order), then any ad-hoc values,
 * with the no-value group last. A multi-select row appears in every group it
 * belongs to — the Notion board behavior.
 */
export function groupRows(rows: RowData[], groupBy: string, schema: CollectionSchema): RowGroup[] {
  const prop = schema.properties.find((p) => p.id === groupBy);
  const buckets = new Map<string, RowData[]>();
  const push = (key: string, row: RowData) => {
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  };

  // seed declared options so empty columns still render (a board needs them)
  if (prop?.type === 'select' || prop?.type === 'multi_select') {
    for (const opt of prop.options ?? []) buckets.set(opt, []);
  } else if (prop?.type === 'checkbox') {
    buckets.set('true', []);
    buckets.set('false', []);
  }

  for (const row of rows) {
    const value = groupBy === 'title' ? row.title : row.properties[groupBy];
    if (prop?.type === 'multi_select' && Array.isArray(value)) {
      if (value.length === 0) push('', row);
      else for (const v of value) push(String(v), row);
      continue;
    }
    if (prop?.type === 'checkbox') {
      push(value ? 'true' : 'false', row);
      continue;
    }
    push(isEmptyValue(value) ? '' : String(value), row);
  }

  const label = (key: string): string => {
    if (key === '') return EMPTY_GROUP_LABEL;
    if (prop?.type === 'checkbox') return key === 'true' ? 'Coché' : 'Non coché';
    return key;
  };

  const entries = [...buckets.entries()].filter(([key, list]) => key !== '' || list.length > 0);
  entries.sort(([a], [b]) => {
    if (a === '') return 1; // no-value group last
    if (b === '') return -1;
    // checked before unchecked (alphabetical would put 'false' first)
    if (prop?.type === 'checkbox') return a === 'true' ? -1 : 1;
    const declared = prop?.options;
    if (declared) {
      const ia = declared.indexOf(a);
      const ib = declared.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
    }
    return a.localeCompare(b);
  });
  return entries.map(([key, list]) => ({ key, label: label(key), rows: list }));
}

/**
 * Filters + sorts + optional grouping in one call (what views actually need).
 * Derived properties are resolved FIRST so formulas and rollups can be
 * filtered, sorted and grouped on like any other column.
 */
export function evaluateView(
  rows: RowData[],
  view: ViewConfig,
  schema: CollectionSchema,
  ctx: ComputeContext = {},
): { rows: RowData[]; groups: RowGroup[] | null } {
  const hasComputed = schema.properties.some((p) => COMPUTED_TYPES.has(p.type));
  const resolved = hasComputed
    ? rows.map((row) => ({ ...row, properties: computeRow(row, schema, ctx) }))
    : rows;
  const visible = applyView(resolved, view, schema);
  return {
    rows: visible,
    groups: view.groupBy ? groupRows(visible, view.groupBy, schema) : null,
  };
}

/** Properties shown in a view, in schema order, honoring `hidden`. */
export function visibleProperties(schema: CollectionSchema, view: ViewConfig): PropertyDef[] {
  const hidden = new Set(view.hidden ?? []);
  return schema.properties.filter((p) => !hidden.has(p.id));
}

/** Human formatting of a cell value for read-only display. */
export function formatValue(v: unknown, type: PropertyType): string {
  if (isEmptyValue(v)) return type === 'rollup' && typeof v === 'number' ? String(v) : '';
  if (type === 'checkbox') return v ? '✓' : '';
  if (typeof v === 'boolean') return v ? 'Vrai' : 'Faux';
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 100) / 100);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}


/**
 * What a database view needs from its host.
 *
 * @remarks
 * §2.5 keeps four record kinds apart: a *view block* places a database in a
 * page, a *view* holds layout and filters, a *schema* holds typed properties,
 * and the *rows are pages*. Only the first is a block, so the editor cannot
 * own the other three — they belong to whatever owns the workspace.
 *
 * The contract lives here rather than in the view layer because it speaks only
 * in core types, and because two things now implement it: an application over
 * `@nbe/workspace`, and any host that keeps its collections elsewhere. A
 * contract defined by its only consumer is a contract that cannot have a
 * second implementation.
 *
 * @category Databases
 */
export interface DatabaseData {
  schema: CollectionSchema;
  view: ViewConfig;
  rows: RowData[];
}

export interface DatabaseHost {
  get(collectionId: string): DatabaseData | null;
  create(): { collectionId: string } | null;
  addRow(collectionId: string, initialProperties?: Record<string, unknown>): void;
  deleteRow(collectionId: string, pageId: string): void;
  updateCell(collectionId: string, pageId: string, propertyId: string, value: unknown): void;
  addProperty(collectionId: string): void;
  updateProperty(collectionId: string, prop: PropertyDef): void;
  deleteProperty(collectionId: string, propertyId: string): void;
  updateView(collectionId: string, view: ViewConfig): void;
  updateSchemaName?(collectionId: string, name: string): void;
  /** All collections in the workspace — the relation picker needs targets. */
  listCollections?(): Array<{ id: string; name: string }>;
  /** Bulk-create rows (CSV import): creating pages is the host's job. */
  importRows?(collectionId: string, rows: RowData[]): void;
  openRow(pageId: string): void;
  onChange(cb: () => void): () => void;
}
