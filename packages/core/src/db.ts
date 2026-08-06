/**
 * Database model (ARCHITECTURE §2.5, phase 3): the four record kinds.
 * - the `database` BLOCK (schema.ts) is the placement in a page (view block)
 * - CollectionSchema (typed properties) and ViewConfig (layout/filter/sort)
 *   are workspace-level records owned by the host
 * - rows are ordinary pages whose props carry { collectionId, properties }
 * This module is the pure evaluation engine; rendering lives in @nbe/dom and
 * storage in the host. Formulas/relations/rollups are AQ#8 (later slice).
 */

export type PropertyType = 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'checkbox' | 'url';

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  /** select / multi_select choices */
  options?: string[];
}

export interface CollectionSchema {
  id: string;
  name: string;
  properties: PropertyDef[];
}

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

export interface ViewConfig {
  id: string;
  layout: 'table'; // board | list | gallery in a later slice
  filters: Filter[];
  sorts: Sort[];
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

/** Human formatting of a cell value for read-only display. */
export function formatValue(v: unknown, type: PropertyType): string {
  if (isEmptyValue(v)) return '';
  if (type === 'checkbox') return v ? '✓' : '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
