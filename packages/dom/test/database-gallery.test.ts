// @vitest-environment happy-dom
//
// The gallery is the board's card in a grid, plus a cover strip. There is no
// file property type, so the cover is inferred from a url property that points
// at an image — this pins that inference and the grouped/ungrouped shapes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Block, CollectionSchema, PropertyDef, RowData, ViewConfig } from '@nbe/core';
import { renderDatabase } from '../src/database';
import type { DatabaseData, DatabaseHost } from '../src/database';
import type { EditorView } from '../src/view';

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

const PROPS: PropertyDef[] = [
  { id: 'photo', name: 'Photo', type: 'url' },
  { id: 'statut', name: 'Statut', type: 'select', options: ['actif', 'archivé'] },
];

function host(rows: RowData[], view: Partial<ViewConfig> = {}): DatabaseHost {
  const schema: CollectionSchema = { id: 'c1', name: 'Films', properties: PROPS };
  const data: DatabaseData = {
    schema,
    view: { id: 'v1', layout: 'gallery', filters: [], sorts: [], ...view },
    rows,
  };
  return {
    get: () => data,
    create: () => null,
    addRow: () => {},
    deleteRow: () => {},
    updateCell: () => {},
    addProperty: () => {},
    updateProperty: () => {},
    deleteProperty: () => {},
    updateView: () => {},
    openRow: () => {},
    onChange: () => () => {},
  };
}

const block = { id: 'b1', type: 'database', version: 1, props: { collectionId: 'c1' }, children: [] } as unknown as Block;

const render = (h: DatabaseHost) =>
  renderDatabase({ options: { database: h } } as unknown as EditorView, block);

const row = (title: string, properties: Record<string, unknown> = {}): RowData => ({
  pageId: `p-${title}`,
  title,
  properties,
});

describe('gallery layout', () => {
  it('is offered in the layout switch', () => {
    const el = render(host([]));
    const labels = [...el.querySelectorAll('.nbe-db-layout')].map((b) => b.textContent);
    expect(labels.some((l) => l?.includes('Galerie'))).toBe(true);
  });

  it('lays the rows out as one grid of cards', () => {
    const el = render(host([row('Alien'), row('Solaris')]));
    expect(el.querySelectorAll('.nbe-db-gallery')).toHaveLength(1);
    expect(el.querySelectorAll('.nbe-db-card')).toHaveLength(2);
    expect([...el.querySelectorAll('.nbe-db-cardtitle')].map((t) => t.textContent)).toEqual([
      'Alien',
      'Solaris',
    ]);
  });

  it('uses a url property pointing at an image as the cover', () => {
    const el = render(host([row('Alien', { photo: 'https://example.com/alien.jpg' })]));
    const img = el.querySelector('.nbe-db-cardcover img') as HTMLImageElement;
    expect(img?.src).toBe('https://example.com/alien.jpg');
    expect(img?.loading).toBe('lazy');
  });

  it('marks the cover empty when the url is not an image', () => {
    const el = render(host([row('Alien', { photo: 'https://example.com/fiche' })]));
    expect(el.querySelector('.nbe-db-cardcover img')).toBeNull();
    expect(el.querySelector('.nbe-db-cardcover-empty')).not.toBeNull();
  });

  it('stacks one grid per group when the view is grouped', () => {
    const el = render(
      host([row('Alien', { statut: 'actif' }), row('Solaris', { statut: 'archivé' })], {
        groupBy: 'statut',
      }),
    );
    expect(el.querySelectorAll('.nbe-db-gallery')).toHaveLength(2);
    expect(el.querySelectorAll('.nbe-db-groupheader')).toHaveLength(2);
  });

  it('does not make gallery cards draggable between groups', () => {
    // dragging writes the group property; that is the board's gesture, and a
    // stacked gallery has no column to drop onto
    const el = render(host([row('Alien', { statut: 'actif' })], { groupBy: 'statut' }));
    expect(el.querySelector('.nbe-db-card')?.classList.contains('nbe-db-dragging')).toBe(false);
    expect(el.querySelectorAll('.nbe-db-col')).toHaveLength(0);
  });
});
