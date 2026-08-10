import type { BlockJSON, CollectionSchema, PropertyDef, RowData, ViewConfig } from '@nbe/core';
import { COMPUTED_TYPES, formatValue, uuidv7 } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from './index';
import { emitScalar, readFrontmatter } from './frontmatter';

/**
 * Collection projection (ARCHITECTURE §10, L1): a database becomes plain text
 * a human can read without the tool —
 *   - one .md per row: YAML frontmatter = properties, body = the row page
 *   - rows.csv: a spreadsheet-facing convenience export
 *   - <name>.base: an Obsidian-Bases-shaped YAML view definition
 * Computed properties (formula, rollup) are exported as MATERIALIZED values
 * and marked as such, never as authored data — re-importing must not turn a
 * cached number into a fact (the Notion export mistake).
 */

// ------------------------------------------------------------------- CSV

/** RFC 4180 field quoting. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function collectionToCsv(rows: RowData[], schema: CollectionSchema): string {
  const props = schema.properties;
  const header = ['Titre', ...props.map((p) => (COMPUTED_TYPES.has(p.type) ? `${p.name} (calculé)` : p.name))];
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) {
    const cells = [row.title, ...props.map((p) => formatValue(row.properties[p.id], p.type))];
    lines.push(cells.map(csvField).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Parse RFC 4180 CSV (quoted fields, embedded commas/newlines/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Coerce a CSV cell back to a typed property value. */
export function parseValue(raw: string, type: PropertyDef['type']): unknown {
  const text = raw.trim();
  // an empty checkbox cell means unchecked, not "no value"
  if (type === 'checkbox') return ['✓', 'true', 'vrai', 'oui', 'x', '1'].includes(text.toLowerCase());
  if (text === '') return '';
  switch (type) {
    case 'number': {
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) ? n : '';
    }
    case 'multi_select':
      return text.split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return text;
  }
}

/**
 * Import CSV into rows. Columns are matched to properties by name; a
 * "(calculé)" suffix marks a materialized computed column, which is skipped
 * because its source of truth is the formula, not the exported value.
 */
export function csvToRows(
  text: string,
  schema: CollectionSchema,
): { rows: RowData[]; unknownColumns: string[] } {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const [header, ...body] = table;
  if (!header) return { rows: [], unknownColumns: [] };

  const byName = new Map(schema.properties.map((p) => [p.name.toLowerCase(), p]));
  const unknownColumns: string[] = [];
  const mapping = header.map((raw) => {
    const name = raw.trim();
    if (/^titre$|^title$/i.test(name)) return { kind: 'title' as const };
    const computed = /\s*\(calculé\)$/i.test(name);
    const prop = byName.get(name.replace(/\s*\(calculé\)$/i, '').toLowerCase());
    if (!prop) {
      if (name) unknownColumns.push(name);
      return { kind: 'skip' as const };
    }
    // never re-import a materialized computed value as authored data
    if (computed || COMPUTED_TYPES.has(prop.type)) return { kind: 'skip' as const };
    return { kind: 'prop' as const, prop };
  });

  const rows: RowData[] = body.map((cells) => {
    const properties: Record<string, unknown> = {};
    let title = '';
    mapping.forEach((m, i) => {
      const cell = cells[i] ?? '';
      if (m.kind === 'title') title = cell.trim();
      else if (m.kind === 'prop') properties[m.prop.id] = parseValue(cell, m.prop.type);
    });
    return { pageId: uuidv7(), title, properties };
  });
  return { rows, unknownColumns: [...new Set(unknownColumns)] };
}

// -------------------------------------------------------------- YAML bits

/**
 * A property value as YAML: a scalar, or a block sequence for a multi-value.
 *
 * @remarks
 * The scalar half lives in `./frontmatter` — it was written twice, here and
 * there, and the two copies had already drifted: this one wrote a title of
 * « 42 » unquoted, which reads back as the number. A list stays a *block*
 * sequence rather than the flow style the frontmatter module writes, because a
 * row file is meant to be read and edited by hand in a vault.
 */
function yamlValue(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '\n' + value.map((v) => `${indent}  - ${emitScalar(v)}`).join('\n');
  }
  return emitScalar(value);
}

/** One markdown file per row: frontmatter properties + the row page body. */
export function rowToMarkdown(
  row: RowData,
  schema: CollectionSchema,
  page?: BlockJSON,
): string {
  const lines = ['---'];
  if (row.title) lines.push(`title: ${emitScalar(row.title)}`);
  for (const prop of schema.properties) {
    const value = row.properties[prop.id];
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (COMPUTED_TYPES.has(prop.type)) {
      // materialized cache, not data: keep the source next to it
      lines.push(`${prop.name} (calculé): ${yamlValue(value, '')}`);
      continue;
    }
    lines.push(`${prop.name}: ${yamlValue(value, '')}`);
  }
  lines.push('---', '');
  const body = page?.children?.length ? blocksToMarkdown(page.children) : '';
  return lines.join('\n') + body;
}

/**
 * Read a row back from its markdown file (frontmatter + body).
 *
 * @remarks
 * The YAML is `readFrontmatter`'s to read — this used to walk the lines itself,
 * tracking whether the previous key had opened a list, which is a second
 * parser for a format the package already parses. Values arrive typed, so all
 * that is left here is the part that is actually about collections: matching a
 * key to a property by *name*, and refusing to re-import a computed value.
 */
export function markdownToRow(
  text: string,
  schema: CollectionSchema,
): { row: RowData; blocks: BlockJSON[] } {
  const { frontmatter, body } = readFrontmatter(text);
  const properties: Record<string, unknown> = {};
  const byName = new Map(schema.properties.map((p) => [p.name.toLowerCase(), p]));
  let title = '';
  for (const key of frontmatter.keys()) {
    const value = frontmatter.get(key);
    if (/^title$/i.test(key)) {
      title = value === null || value === undefined ? '' : String(value);
      continue;
    }
    if (/\(calculé\)$/i.test(key)) continue; // materialized cache — never re-imported
    const prop = byName.get(key.toLowerCase());
    if (!prop) continue;
    // a list is already a list; a scalar goes back through the CSV coercion, so
    // one property type means one parse whichever projection it arrived by
    properties[prop.id] = Array.isArray(value)
      ? value.map((v) => String(v))
      : parseValue(value === null || value === undefined ? '' : String(value), prop.type);
  }
  return {
    row: { pageId: uuidv7(), title, properties },
    blocks: body.trim() ? markdownToBlocks(body) : [],
  };
}

/** Obsidian-Bases-shaped view definition (ARCHITECTURE §10 interop target). */
export function viewToBase(schema: CollectionSchema, view: ViewConfig): string {
  const name = (id: string) =>
    id === 'title' ? 'title' : (schema.properties.find((p) => p.id === id)?.name ?? id);
  const lines = ['filters:'];
  if (view.filters.length) {
    lines.push('  and:');
    for (const f of view.filters) {
      const target = `${name(f.propertyId)}`;
      const expr =
        f.op === 'empty'
          ? `${target}.isEmpty()`
          : f.op === 'not_empty'
            ? `!${target}.isEmpty()`
            : f.op === 'contains'
              ? `${target}.contains("${f.value ?? ''}")`
              : `${target} ${{ eq: '==', neq: '!=', gt: '>', lt: '<' }[f.op] ?? '=='} "${f.value ?? ''}"`;
      lines.push(`    - '${expr}'`);
    }
  } else {
    lines.push('  and: []');
  }
  lines.push('views:');
  lines.push(`  - type: ${view.layout}`);
  lines.push(`    name: ${emitScalar(schema.name)}`);
  if (view.groupBy) lines.push(`    group_by: ${emitScalar(name(view.groupBy))}`);
  if (view.sorts.length) {
    lines.push('    order:');
    for (const s of view.sorts) lines.push(`      - ${emitScalar(name(s.propertyId))} ${s.dir}`);
  }
  lines.push('    properties:');
  for (const p of schema.properties) lines.push(`      - ${emitScalar(p.name)}`);
  return lines.join('\n') + '\n';
}

/**
 * Whole-collection vault projection: a map of relative file path → contents.
 * Opening the folder in a text editor (or Obsidian) shows every row.
 */
export function collectionToVault(
  schema: CollectionSchema,
  view: ViewConfig,
  rows: RowData[],
  pages: Map<string, BlockJSON> = new Map(),
): Record<string, string> {
  const dir = safeName(schema.name);
  const files: Record<string, string> = {
    [`${dir}/${dir}.base`]: viewToBase(schema, view),
    [`${dir}/rows.csv`]: collectionToCsv(rows, schema),
  };
  const used = new Set<string>();
  for (const row of rows) {
    let base = safeName(row.title || 'Sans titre');
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base} ${n++}`;
    used.add(name);
    files[`${dir}/${name}.md`] = rowToMarkdown(row, schema, pages.get(row.pageId));
  }
  return files;
}

/** Filesystem-safe, human-readable file name (no uuid suffixes — the Notion sin). */
export function safeName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Sans titre'
  );
}
