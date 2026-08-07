import { describe, expect, it } from 'vitest';
import { collectionFromRows } from '../src/collection';

/**
 * A CSV becomes §2.5's four records, not a flat table.
 *
 * The inference is the part that can hurt, so most of this is about when it
 * refuses to guess: a wrong property type hides values and breaks sorting, and
 * it is discovered weeks later. Text is always readable and always editable.
 */

const rows = (...lines: string[][]) => lines;

describe('the four records come out separately', () => {
  const imported = collectionFromRows('Tâches', rows(
    ['Nom', 'Statut', 'Fait'],
    ['Écrire', 'En cours', 'Non'],
    ['Relire', 'À faire', 'Non'],
  ))!;

  it('a schema, a view, rows and a block to place it', () => {
    expect(imported.schema.name).toBe('Tâches');
    expect(imported.view.layout).toBe('table');
    expect(imported.rows).toHaveLength(2);
    expect(imported.viewBlock.type).toBe('database');
  });

  it('the block points at the schema and the view it shows', () => {
    expect(imported.viewBlock.props!['collectionId']).toBe(imported.schema.id);
    expect(imported.viewBlock.props!['viewId']).toBe(imported.view.id);
  });

  it('rows are pages, carrying their collection and their values', () => {
    const row = imported.rows[0]!;
    expect(row.type).toBe('page');
    expect(row.props!['collectionId']).toBe(imported.schema.id);
    expect(row.props!['title']).toBe('Écrire');
  });

  it('the first column is the row title, not a property', () => {
    expect(imported.schema.properties.map((p) => p.name)).toEqual(['Statut', 'Fait']);
  });

  it('says the types were inferred rather than declared', () => {
    expect(imported.schema.inferred).toBe(true);
  });

  it('returns nothing when there is no header to work from', () => {
    expect(collectionFromRows('vide', [])).toBeNull();
  });
});

describe('a column is typed only when every value fits', () => {
  const typeOf = (values: string[]) =>
    collectionFromRows('x', [['Nom', 'Col'], ...values.map((v, i) => [`ligne ${i}`, v])])!.schema.properties[0]!;

  it('numbers', () => {
    expect(typeOf(['1', '2', '3.5']).type).toBe('number');
  });

  it('but not when one value is not a number', () => {
    expect(typeOf(['1', '2', 'environ trois']).type).toBe('text');
  });

  it('checkboxes, in either language', () => {
    expect(typeOf(['Yes', 'No', 'Oui', 'Non']).type).toBe('checkbox');
  });

  it('dates that look like dates', () => {
    expect(typeOf(['2026-08-07', '2026-01-01']).type).toBe('date');
  });

  it('but not a column of years, which merely parses as one', () => {
    // Date.parse('2026') succeeds and means January the first — a silent lie
    expect(typeOf(['2026', '2025']).type).toBe('number');
  });

  it('urls', () => {
    expect(typeOf(['https://a.example', 'http://b.example']).type).toBe('url');
  });

  it('a repeating column becomes a select, with its options', () => {
    const prop = typeOf(['À faire', 'En cours', 'À faire', 'Fini', 'En cours', 'À faire']);
    expect(prop.type).toBe('select');
    expect(new Set(prop.options)).toEqual(new Set(['À faire', 'En cours', 'Fini']));
  });

  it('a column of distinct names does not', () => {
    expect(typeOf(['Alice', 'Bob', 'Carole', 'Denis', 'Émile', 'Fanny']).type).toBe('text');
  });

  it('an empty column stays text', () => {
    expect(typeOf(['', '', '']).type).toBe('text');
  });
});

describe('values arrive as the type expects them', () => {
  it('numbers are numbers, including the French decimal comma', () => {
    const imported = collectionFromRows('x', rows(['Nom', 'Prix'], ['A', '1,50'], ['B', '2']))!;
    const prop = imported.schema.properties[0]!;
    expect(imported.rows[0]!.props!['properties']).toEqual({ [prop.id]: 1.5 });
  });

  it('checkboxes are booleans, and an empty cell is false', () => {
    const imported = collectionFromRows('x', rows(['Nom', 'Fait'], ['A', 'Oui'], ['B', '']))!;
    const prop = imported.schema.properties[0]!;
    expect(imported.rows[0]!.props!['properties']).toEqual({ [prop.id]: true });
    expect(imported.rows[1]!.props!['properties']).toEqual({ [prop.id]: false });
  });
});
