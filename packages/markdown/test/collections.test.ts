import { describe, expect, it } from 'vitest';
import type { CollectionSchema, RowData, ViewConfig } from '@nbe/core';
import {
  collectionToCsv,
  collectionToVault,
  csvToRows,
  markdownToRow,
  parseCsv,
  rowToMarkdown,
  safeName,
  viewToBase,
} from '../src/collections';

const schema: CollectionSchema = {
  id: 'c1',
  name: 'Tâches',
  properties: [
    { id: 'p_status', name: 'Statut', type: 'select', options: ['À faire', 'Fait'] },
    { id: 'p_prio', name: 'Priorité', type: 'number' },
    { id: 'p_done', name: 'OK', type: 'checkbox' },
    { id: 'p_tags', name: 'Tags', type: 'multi_select' },
    { id: 'p_total', name: 'Total', type: 'formula', formula: 'prop("Priorité") * 2' },
  ],
};

const rows: RowData[] = [
  {
    pageId: 'r1',
    title: 'Écrire, tester',
    properties: { p_status: 'Fait', p_prio: 3, p_done: true, p_tags: ['pro', 'urgent'], p_total: 6 },
  },
  { pageId: 'r2', title: 'Relire "le doc"', properties: { p_status: 'À faire', p_prio: 1, p_done: false } },
];

const view: ViewConfig = {
  id: 'v',
  layout: 'table',
  filters: [{ propertyId: 'p_status', op: 'eq', value: 'Fait' }],
  sorts: [{ propertyId: 'p_prio', dir: 'desc' }],
  groupBy: 'p_status',
};

describe('CSV', () => {
  it('quotes fields containing commas, quotes and newlines', () => {
    const csv = collectionToCsv(rows, schema);
    expect(csv.split('\n')[0]).toBe('Titre,Statut,Priorité,OK,Tags,Total (calculé)');
    expect(csv).toContain('"Écrire, tester"');
    expect(csv).toContain('"Relire ""le doc"""');
    expect(csv).toContain('"pro, urgent"');
  });

  it('round-trips through the parser', () => {
    const parsed = parseCsv(collectionToCsv(rows, schema));
    expect(parsed).toHaveLength(3);
    expect(parsed[1]![0]).toBe('Écrire, tester');
    expect(parsed[2]![0]).toBe('Relire "le doc"');
  });

  it('parses embedded newlines inside quoted fields', () => {
    const table = parseCsv('a,"deux\nlignes",c\n1,2,3\n');
    expect(table[0]).toEqual(['a', 'deux\nlignes', 'c']);
    expect(table[1]).toEqual(['1', '2', '3']);
  });

  it('imports back with typed coercion, matching columns by name', () => {
    const { rows: imported, unknownColumns } = csvToRows(collectionToCsv(rows, schema), schema);
    expect(unknownColumns).toEqual([]);
    expect(imported[0]!.title).toBe('Écrire, tester');
    expect(imported[0]!.properties['p_prio']).toBe(3);
    expect(imported[0]!.properties['p_done']).toBe(true);
    expect(imported[0]!.properties['p_tags']).toEqual(['pro', 'urgent']);
    expect(imported[1]!.properties['p_done']).toBe(false);
  });

  it('never re-imports a materialized computed column as authored data', () => {
    const { rows: imported } = csvToRows(collectionToCsv(rows, schema), schema);
    expect(imported[0]!.properties['p_total']).toBeUndefined();
  });

  it('reports unknown columns instead of silently dropping them', () => {
    const { unknownColumns } = csvToRows('Titre,Inconnue\nx,y\n', schema);
    expect(unknownColumns).toEqual(['Inconnue']);
  });

  it('gives fresh ids on import (rows are new pages)', () => {
    const { rows: a } = csvToRows(collectionToCsv(rows, schema), schema);
    const { rows: b } = csvToRows(collectionToCsv(rows, schema), schema);
    expect(a[0]!.pageId).not.toBe(b[0]!.pageId);
  });
});

describe('row markdown', () => {
  it('writes frontmatter and marks computed values as cache', () => {
    const md = rowToMarkdown(rows[0]!, schema);
    expect(md).toContain('title: "Écrire, tester"');
    expect(md).toContain('Statut: Fait');
    expect(md).toContain('Priorité: 3');
    expect(md).toContain('Total (calculé): 6');
  });

  it('round-trips properties and body, skipping computed values', () => {
    const page = {
      id: 'p',
      type: 'page',
      version: 1,
      children: [
        { id: 'h', type: 'heading', version: 1, props: { level: 2 }, text: [{ text: 'Notes' }] },
        { id: 'b', type: 'paragraph', version: 1, text: [{ text: 'du corps' }] },
      ],
    };
    const md = rowToMarkdown(rows[0]!, schema, page);
    const { row, blocks } = markdownToRow(md, schema);
    expect(row.title).toBe('Écrire, tester');
    expect(row.properties['p_status']).toBe('Fait');
    expect(row.properties['p_prio']).toBe(3);
    expect(row.properties['p_done']).toBe(true);
    expect(row.properties['p_total']).toBeUndefined(); // cache, not data
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('reads a hand-written file with a YAML list', () => {
    const { row } = markdownToRow(
      ['---', 'title: Manuel', 'Statut: Fait', 'Tags:', '  - a', '  - b', '---', '', 'corps'].join('\n'),
      schema,
    );
    expect(row.title).toBe('Manuel');
    expect(row.properties['p_tags']).toEqual(['a', 'b']);
  });
});

describe('vault projection', () => {
  it('emits one readable .md per row plus rows.csv and a .base view', () => {
    const files = collectionToVault(schema, view, rows);
    expect(Object.keys(files).sort()).toEqual([
      'Tâches/Relire le doc.md',
      'Tâches/rows.csv',
      'Tâches/Écrire, tester.md',
      'Tâches/Tâches.base',
    ].sort());
    // human file names, no uuid suffixes (the Notion export complaint)
    expect(Object.keys(files).every((f) => !/[0-9a-f]{8}-[0-9a-f]{4}/.test(f))).toBe(true);
  });

  it('deduplicates colliding file names instead of overwriting a row', () => {
    const dup: RowData[] = [
      { pageId: 'a', title: 'Même', properties: {} },
      { pageId: 'b', title: 'Même', properties: {} },
    ];
    const files = collectionToVault(schema, view, dup);
    expect(files['Tâches/Même.md']).toBeDefined();
    expect(files['Tâches/Même 2.md']).toBeDefined();
  });

  it('base view carries filters, sort, group and property order', () => {
    const base = viewToBase(schema, view);
    expect(base).toContain('filters:');
    expect(base).toContain("- 'Statut == \"Fait\"'");
    expect(base).toContain('type: table');
    expect(base).toContain('group_by: Statut');
    expect(base).toContain('- Priorité desc');
    expect(base).toContain('- Total');
  });

  it('safeName strips path-hostile characters but keeps accents', () => {
    expect(safeName('a/b:c*?"<>|')).toBe('abc');
    expect(safeName('Réunion été')).toBe('Réunion été');
    expect(safeName('   ')).toBe('Sans titre');
  });
});
