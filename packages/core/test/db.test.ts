import { describe, expect, it } from 'vitest';
import {
  applyView,
  compareRows,
  computeRow,
  evaluateView,
  formatValue,
  groupRows,
  matchesFilter,
  visibleProperties,
} from '../src/db';
import type { CollectionSchema, RowData, ViewConfig } from '../src/db';

const schema: CollectionSchema = {
  id: 'c1',
  name: 'Tâches',
  properties: [
    { id: 'p_status', name: 'Statut', type: 'select', options: ['À faire', 'En cours', 'Fait'] },
    { id: 'p_prio', name: 'Priorité', type: 'number' },
    { id: 'p_done', name: 'OK', type: 'checkbox' },
    { id: 'p_due', name: 'Échéance', type: 'date' },
    { id: 'p_tags', name: 'Tags', type: 'multi_select', options: ['perso', 'pro'] },
  ],
};

const rows: RowData[] = [
  { pageId: 'r1', title: 'Alpha', properties: { p_status: 'Fait', p_prio: 2, p_done: true, p_due: '2026-01-10', p_tags: ['pro'] } },
  { pageId: 'r2', title: 'Bravo', properties: { p_status: 'À faire', p_prio: 10, p_done: false, p_due: '2025-12-01', p_tags: ['perso', 'pro'] } },
  { pageId: 'r3', title: 'Charlie', properties: { p_status: 'En cours', p_done: false, p_tags: [] } },
];

const view = (over: Partial<ViewConfig>): ViewConfig => ({ id: 'v', layout: 'table', filters: [], sorts: [], ...over });

describe('matchesFilter', () => {
  it('eq/neq with select and title', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'p_status', op: 'eq', value: 'Fait' }, schema)).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'p_status', op: 'neq', value: 'Fait' }, schema)).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'title', op: 'eq', value: 'alpha' }, schema)).toBe(true);
  });

  it('contains on text and multi_select', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'title', op: 'contains', value: 'lph' }, schema)).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'p_tags', op: 'contains', value: 'perso' }, schema)).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'p_tags', op: 'contains', value: 'perso' }, schema)).toBe(false);
  });

  it('empty / not_empty treat missing, empty string and empty array as empty', () => {
    expect(matchesFilter(rows[2]!, { propertyId: 'p_prio', op: 'empty' }, schema)).toBe(true);
    expect(matchesFilter(rows[2]!, { propertyId: 'p_tags', op: 'empty' }, schema)).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'p_prio', op: 'not_empty' }, schema)).toBe(true);
  });

  it('gt/lt numeric — 10 > 2 (not string compare)', () => {
    expect(matchesFilter(rows[1]!, { propertyId: 'p_prio', op: 'gt', value: 9 }, schema)).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'p_prio', op: 'lt', value: 10 }, schema)).toBe(true);
    // missing value never matches gt/lt
    expect(matchesFilter(rows[2]!, { propertyId: 'p_prio', op: 'gt', value: 0 }, schema)).toBe(false);
  });

  it('gt/lt on dates', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'p_due', op: 'gt', value: '2025-12-31' }, schema)).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'p_due', op: 'lt', value: '2025-12-31' }, schema)).toBe(true);
  });
});

describe('sorting', () => {
  it('numbers sort numerically, missing values last in both directions', () => {
    const asc = applyView(rows, view({ sorts: [{ propertyId: 'p_prio', dir: 'asc' }] }), schema);
    expect(asc.map((r) => r.pageId)).toEqual(['r1', 'r2', 'r3']);
    const desc = applyView(rows, view({ sorts: [{ propertyId: 'p_prio', dir: 'desc' }] }), schema);
    expect(desc.map((r) => r.pageId)).toEqual(['r2', 'r1', 'r3']);
  });

  it('dates and checkboxes sort by their semantics', () => {
    const byDue = applyView(rows, view({ sorts: [{ propertyId: 'p_due', dir: 'asc' }] }), schema);
    expect(byDue.map((r) => r.pageId)).toEqual(['r2', 'r1', 'r3']);
    expect(compareRows(rows[0]!, rows[1]!, { propertyId: 'p_done', dir: 'desc' }, schema)).toBeLessThan(0);
  });

  it('multi-sort: minor key then major key, stable', () => {
    const extra: RowData = { pageId: 'r4', title: 'Aaron', properties: { p_status: 'Fait', p_prio: 1 } };
    const out = applyView(
      [...rows, extra],
      view({ sorts: [{ propertyId: 'p_status', dir: 'asc' }, { propertyId: 'p_prio', dir: 'asc' }] }),
      schema,
    );
    // grouped by status (asc: 'À faire' < 'En cours' < 'Fait' by locale), prio inside group
    const statusOrder = out.map((r) => (r.properties['p_status'] as string) ?? '(none)');
    expect(statusOrder.indexOf('Fait')).toBeGreaterThan(statusOrder.indexOf('En cours'));
    const faits = out.filter((r) => r.properties['p_status'] === 'Fait').map((r) => r.pageId);
    expect(faits).toEqual(['r4', 'r1']); // prio 1 before prio 2
  });
});

describe('grouping', () => {
  it('groups by select in the declared option order, empty group last', () => {
    const groups = groupRows(rows, 'p_status', schema);
    expect(groups.map((g) => g.label)).toEqual(['À faire', 'En cours', 'Fait']);
    expect(groups.find((g) => g.label === 'Fait')!.rows.map((r) => r.pageId)).toEqual(['r1']);
  });

  it('keeps declared options as empty columns (a board needs them)', () => {
    const groups = groupRows([rows[0]!], 'p_status', schema);
    expect(groups.map((g) => g.label)).toEqual(['À faire', 'En cours', 'Fait']);
    expect(groups.find((g) => g.label === 'À faire')!.rows).toEqual([]);
  });

  it('a multi-select row appears in every group it belongs to', () => {
    const groups = groupRows(rows, 'p_tags', schema);
    const perso = groups.find((g) => g.label === 'perso')!;
    const pro = groups.find((g) => g.label === 'pro')!;
    expect(perso.rows.map((r) => r.pageId)).toEqual(['r2']);
    expect(pro.rows.map((r) => r.pageId)).toEqual(['r1', 'r2']);
    // the row with an empty array lands in the no-value group, listed last
    expect(groups[groups.length - 1]!.key).toBe('');
    expect(groups[groups.length - 1]!.rows.map((r) => r.pageId)).toEqual(['r3']);
  });

  it('checkbox grouping yields both columns with readable labels', () => {
    const groups = groupRows(rows, 'p_done', schema);
    expect(groups.map((g) => g.label)).toEqual(['Coché', 'Non coché']);
    expect(groups[0]!.rows.map((r) => r.pageId)).toEqual(['r1']);
    expect(groups[1]!.rows).toHaveLength(2);
  });

  it('evaluateView applies filters and sorts before grouping', () => {
    const out = evaluateView(
      rows,
      view({ groupBy: 'p_status', filters: [{ propertyId: 'p_done', op: 'eq', value: false }] }),
      schema,
    );
    expect(out.rows.map((r) => r.pageId)).toEqual(['r2', 'r3']);
    expect(out.groups!.find((g) => g.label === 'Fait')!.rows).toEqual([]);
    expect(evaluateView(rows, view({}), schema).groups).toBeNull();
  });

  it('visibleProperties honors the hidden list, keeping schema order', () => {
    expect(visibleProperties(schema, view({})).map((p) => p.id)).toEqual(schema.properties.map((p) => p.id));
    expect(visibleProperties(schema, view({ hidden: ['p_prio', 'p_tags'] })).map((p) => p.name)).toEqual([
      'Statut',
      'OK',
      'Échéance',
    ]);
  });
});

describe('computed properties (formula, relation, rollup)', () => {
  const lines: CollectionSchema = {
    id: 'lines',
    name: 'Lignes',
    properties: [
      { id: 'l_price', name: 'Prix', type: 'number' },
      { id: 'l_qty', name: 'Quantité', type: 'number' },
      { id: 'l_total', name: 'Total', type: 'formula', formula: 'prop("Prix") * prop("Quantité")' },
      { id: 'l_label', name: 'Étiquette', type: 'formula', formula: 'concat(prop("Titre"), " → ", prop("Total"))' },
    ],
  };
  const lineRows: RowData[] = [
    { pageId: 'L1', title: 'Vis', properties: { l_price: 2.5, l_qty: 4 } },
    { pageId: 'L2', title: 'Écrou', properties: { l_price: 1, l_qty: 10 } },
    { pageId: 'L3', title: 'Sans prix', properties: {} },
  ];

  const orders: CollectionSchema = {
    id: 'orders',
    name: 'Commandes',
    properties: [
      { id: 'o_lines', name: 'Lignes', type: 'relation', relation: { collectionId: 'lines' } },
      {
        id: 'o_count',
        name: 'Nb lignes',
        type: 'rollup',
        rollup: { relationPropertyId: 'o_lines', targetPropertyId: 'l_total', fn: 'count' },
      },
      {
        id: 'o_total',
        name: 'Total',
        type: 'rollup',
        rollup: { relationPropertyId: 'o_lines', targetPropertyId: 'l_price', fn: 'sum' },
      },
      {
        id: 'o_names',
        name: 'Articles',
        type: 'rollup',
        rollup: { relationPropertyId: 'o_lines', targetPropertyId: 'title', fn: 'show' },
      },
    ],
  };
  const ctx = {
    relatedRows: (id: string) => (id === 'lines' ? lineRows : []),
    relatedSchema: (id: string) => (id === 'lines' ? lines : null),
  };

  it('evaluates formulas, including one referencing another and the title', () => {
    const computed = computeRow(lineRows[0]!, lines);
    expect(computed['l_total']).toBe(10);
    expect(computed['l_label']).toBe('Vis → 10');
  });

  it('a formula over missing values yields null instead of breaking the row', () => {
    const computed = computeRow(lineRows[2]!, lines);
    expect(computed['l_total']).toBeNull();
    expect(computed['l_label']).toBe('Sans prix → ');
  });

  it('mutually recursive formulas resolve to null instead of hanging', () => {
    const cyclic: CollectionSchema = {
      id: 'c',
      name: 'c',
      properties: [
        { id: 'a', name: 'A', type: 'formula', formula: 'prop("B") + 1' },
        { id: 'b', name: 'B', type: 'formula', formula: 'prop("A") + 1' },
      ],
    };
    const computed = computeRow({ pageId: 'x', title: '', properties: {} }, cyclic);
    expect(computed['a']).toBeNull();
    expect(computed['b']).toBeNull();
  });

  it('rollups aggregate across a relation', () => {
    const order: RowData = { pageId: 'O1', title: 'Commande 1', properties: { o_lines: ['L1', 'L2'] } };
    const computed = computeRow(order, orders, ctx);
    expect(computed['o_count']).toBe(2);
    expect(computed['o_total']).toBe(3.5);
    expect(computed['o_names']).toEqual(['Vis', 'Écrou']);
  });

  it('an empty relation counts zero and aggregates to null', () => {
    const order: RowData = { pageId: 'O2', title: 'Vide', properties: {} };
    const computed = computeRow(order, orders, ctx);
    expect(computed['o_count']).toBe(0);
    expect(computed['o_total']).toBeNull();
  });

  it('views filter and sort on computed values', () => {
    // the row with no price computes to null and is dropped by the filter
    const out = evaluateView(
      lineRows,
      view({ filters: [{ propertyId: 'l_total', op: 'not_empty' }], sorts: [{ propertyId: 'l_total', dir: 'desc' }] }),
      lines,
    );
    expect(out.rows.map((r) => r.pageId)).toEqual(['L1', 'L2']); // equal totals → stable order
    expect(out.rows.map((r) => r.properties['l_total'])).toEqual([10, 10]);

    // a genuine ordering once the totals differ
    const varied = [...lineRows.slice(0, 2), { pageId: 'L4', title: 'Boulon', properties: { l_price: 5, l_qty: 6 } }];
    const desc = evaluateView(varied, view({ sorts: [{ propertyId: 'l_total', dir: 'desc' }] }), lines);
    expect(desc.rows.map((r) => r.pageId)).toEqual(['L4', 'L1', 'L2']);
  });

  it('groups on a computed value', () => {
    const flagged: CollectionSchema = {
      ...lines,
      properties: [
        ...lines.properties,
        { id: 'l_big', name: 'Gros', type: 'formula', formula: 'if(prop("Total") > 5, "gros", "petit")' },
      ],
    };
    const out = evaluateView([...lineRows], view({ groupBy: 'l_big' }), flagged);
    const labels = out.groups!.map((g) => `${g.label}:${g.rows.length}`);
    // if() always returns a branch, so the price-less row (null total, not > 5)
    // lands in "petit" rather than in a no-value group
    expect(labels.sort()).toEqual(['gros:2', 'petit:1']);
  });
});

describe('applyView combined + formatValue', () => {
  it('filters then sorts', () => {
    const out = applyView(
      rows,
      view({
        filters: [{ propertyId: 'p_done', op: 'eq', value: false }],
        sorts: [{ propertyId: 'title', dir: 'desc' }],
      }),
      schema,
    );
    expect(out.map((r) => r.title)).toEqual(['Charlie', 'Bravo']);
  });

  it('formats values per type', () => {
    expect(formatValue(true, 'checkbox')).toBe('✓');
    expect(formatValue(['a', 'b'], 'multi_select')).toBe('a, b');
    expect(formatValue(undefined, 'text')).toBe('');
  });
});
