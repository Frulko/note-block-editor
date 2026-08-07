import { beforeEach, describe, expect, it } from 'vitest';
import type { RowData } from '@nbe/core';
import { Workspace, memoryStorage } from '../src/index';
import { createDatabaseHost, memoryCollections, type CollectionRecord } from '../src/database';

/**
 * §2.5's four records over a workspace.
 *
 * The one worth checking hardest is that rows are **derived**: a page belongs
 * to a collection because its own props say so, and nothing keeps a second
 * list that could disagree.
 */

let workspace: Workspace;
let records: CollectionRecord[];
let host: ReturnType<typeof createDatabaseHost>;
let opened: string[];

/** Let the host's deferred writes land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  workspace = new Workspace(memoryStorage());
  await workspace.load();
  records = [];
  opened = [];
  host = createDatabaseHost(workspace, records, memoryCollections(records), {
    openPage: (id) => opened.push(id),
  });
});

async function withRows(count: number): Promise<string> {
  const { collectionId } = host.create()!;
  for (let i = 0; i < count; i++) host.addRow(collectionId, {});
  await settle();
  return collectionId;
}

describe('a collection is a schema, a view and pages', () => {
  it('creating one yields both records and no rows', () => {
    const { collectionId } = host.create()!;
    const data = host.get(collectionId)!;
    expect(data.schema.properties).toHaveLength(1);
    expect(data.view.layout).toBe('table');
    expect(data.rows).toEqual([]);
  });

  it('an unknown collection is null, not a crash', () => {
    expect(host.get('absent')).toBeNull();
  });

  it('a row is a page in the workspace', async () => {
    const collectionId = await withRows(1);
    const row = host.get(collectionId)!.rows[0]!;
    expect(workspace.node(row.pageId)).toBeDefined();
  });

  it('opening a row opens its page', async () => {
    const collectionId = await withRows(1);
    host.openRow(host.get(collectionId)!.rows[0]!.pageId);
    expect(opened).toHaveLength(1);
  });
});

describe('rows are derived, never listed', () => {
  it('a page joins a collection because its own props say so', async () => {
    const collectionId = await withRows(1);
    const pageId = host.get(collectionId)!.rows[0]!.pageId;
    expect(workspace.document(pageId)!.props!['collectionId']).toBe(collectionId);
  });

  it('deleting the page removes the row, with nothing to keep in step', async () => {
    const collectionId = await withRows(2);
    const [first] = host.get(collectionId)!.rows;
    await workspace.deletePage(first!.pageId);
    expect(host.get(collectionId)!.rows).toHaveLength(1);
  });

  it('a page belonging to another collection is not in these rows', async () => {
    const a = await withRows(1);
    const b = await withRows(1);
    expect(host.get(a)!.rows).toHaveLength(1);
    expect(host.get(b)!.rows).toHaveLength(1);
  });

  it('an ordinary page is in no collection at all', async () => {
    const collectionId = await withRows(1);
    await workspace.createPage({ title: 'Une note' });
    expect(host.get(collectionId)!.rows).toHaveLength(1);
  });

  it('rows come back in creation order', async () => {
    const collectionId = host.create()!.collectionId;
    for (const name of ['un', 'deux', 'trois']) {
      host.addRow(collectionId, { n: name });
      await settle();
    }
    expect(host.get(collectionId)!.rows.map((r) => r.properties['n'])).toEqual(['un', 'deux', 'trois']);
  });
});

describe('editing', () => {
  it('a cell is written on the row page', async () => {
    const collectionId = await withRows(1);
    const { pageId } = host.get(collectionId)!.rows[0]!;
    const property = host.get(collectionId)!.schema.properties[0]!;

    host.updateCell(collectionId, pageId, property.id, 'valeur');
    await settle();
    expect(host.get(collectionId)!.rows[0]!.properties[property.id]).toBe('valeur');
    expect((workspace.document(pageId)!.props!['properties'] as Record<string, unknown>)[property.id]).toBe('valeur');
  });

  it('adding a property leaves existing rows readable', async () => {
    const collectionId = await withRows(1);
    host.addProperty(collectionId);
    expect(host.get(collectionId)!.schema.properties).toHaveLength(2);
    expect(host.get(collectionId)!.rows).toHaveLength(1);
  });

  it('a property can be retyped and renamed', async () => {
    const collectionId = await withRows(0);
    const property = host.get(collectionId)!.schema.properties[0]!;
    host.updateProperty(collectionId, { ...property, name: 'Statut', type: 'select', options: ['A', 'B'] });
    const updated = host.get(collectionId)!.schema.properties[0]!;
    expect(updated.name).toBe('Statut');
    expect(updated.type).toBe('select');
  });

  it('deleting a property leaves the values on the pages', async () => {
    const collectionId = await withRows(1);
    const property = host.get(collectionId)!.schema.properties[0]!;
    const { pageId } = host.get(collectionId)!.rows[0]!;
    host.updateCell(collectionId, pageId, property.id, 'gardé');
    await settle();

    host.deleteProperty(collectionId, property.id);
    expect(host.get(collectionId)!.schema.properties).toHaveLength(0);
    // a deleted column is usually a mistake; a column that comes back empty
    // would be worse than one that comes back
    expect((workspace.document(pageId)!.props!['properties'] as Record<string, unknown>)[property.id]).toBe('gardé');
  });

  it('the view is replaced whole, filters and sorts included', async () => {
    const collectionId = await withRows(0);
    const view = host.get(collectionId)!.view;
    host.updateView(collectionId, { ...view, layout: 'board', sorts: [{ propertyId: 'x', dir: 'asc' }] });
    expect(host.get(collectionId)!.view.layout).toBe('board');
    expect(host.get(collectionId)!.view.sorts).toHaveLength(1);
  });

  it('a rename shows up in the collection list', async () => {
    const collectionId = await withRows(0);
    host.updateSchemaName!(collectionId, 'Tâches');
    expect(host.listCollections!()).toEqual([{ id: collectionId, name: 'Tâches' }]);
  });
});

describe('importing rows in bulk', () => {
  it('creates one page per row, carrying its values', async () => {
    const collectionId = host.create()!.collectionId;
    const property = host.get(collectionId)!.schema.properties[0]!;
    const rows: RowData[] = [
      { pageId: '', title: 'Alice', properties: { [property.id]: 'A' } },
      { pageId: '', title: 'Bob', properties: { [property.id]: 'B' } },
    ];
    host.importRows!(collectionId, rows);
    await settle();

    const imported = host.get(collectionId)!.rows;
    expect(imported).toHaveLength(2);
    expect(imported.map((row) => row.title).sort()).toEqual(['Alice', 'Bob']);
  });
});

describe('the records are persisted', () => {
  it('a written store gives the same collections back', async () => {
    const store = memoryCollections(records);
    const persisted = createDatabaseHost(workspace, records, store, { openPage: () => {} });
    const { collectionId } = persisted.create()!;
    persisted.updateSchemaName!(collectionId, 'Suivi');
    await settle();

    expect((await store.read()).map((record) => record.schema.name)).toEqual(['Suivi']);
  });

  it('a failing store reports rather than pretending', async () => {
    const failures: unknown[] = [];
    const broken = createDatabaseHost(
      workspace,
      [],
      { read: async () => [], write: async () => { throw new Error('disque plein'); } },
      { openPage: () => {}, onError: (error) => failures.push(error) },
    );
    broken.create();
    await settle();
    expect(failures).toHaveLength(1);
  });

  it('a change notifies its listeners', async () => {
    let seen = 0;
    const stop = host.onChange(() => seen++);
    host.create();
    expect(seen).toBe(1);
    stop();
    host.create();
    expect(seen).toBe(1);
  });
});
