import { uuidv7, type CollectionSchema, type PropertyDef, type ViewConfig } from '@nbe/core';
import type { DatabaseData, DatabaseHost } from '@nbe/dom';
import { createPage, pageTitle, saveWorkspace, type Workspace } from './workspace';

export interface CollectionRecord {
  schema: CollectionSchema;
  view: ViewConfig;
  rowIds: string[];
}

/**
 * Demo DatabaseHost over the localStorage workspace: schema + view are
 * workspace records, rows are ordinary pages carrying
 * props.collectionId + props.properties (ARCHITECTURE §2.5 — rows as pages).
 */
export function createDatabaseHost(ws: Workspace, opts: { openPage: (id: string) => void; onMutate: () => void }): DatabaseHost {
  const listeners = new Set<() => void>();
  const notify = () => {
    saveWorkspace(ws);
    opts.onMutate();
    for (const l of listeners) l();
  };
  const record = (collectionId: string): CollectionRecord | undefined =>
    (ws.collections ?? []).find((c) => c.schema.id === collectionId);

  const addRowTo = (rec: CollectionRecord): string => {
    const page = createPage(ws, '');
    page.props = { ...page.props, collectionId: rec.schema.id, properties: {} };
    rec.rowIds.push(page.id);
    return page.id;
  };

  return {
    get(collectionId): DatabaseData | null {
      const rec = record(collectionId);
      if (!rec) return null;
      const rows = rec.rowIds
        .map((id) => ws.pages.find((p) => p.id === id))
        .filter((p) => p !== undefined)
        .map((p) => ({
          pageId: p!.id,
          title: pageTitle(p!) === 'Sans titre' ? '' : pageTitle(p!),
          properties: (p!.props?.['properties'] as Record<string, unknown>) ?? {},
        }));
      return { schema: rec.schema, view: rec.view, rows };
    },

    create() {
      ws.collections ??= [];
      const rec: CollectionRecord = {
        schema: {
          id: uuidv7(),
          name: 'Base de données',
          properties: [
            { id: uuidv7(), name: 'Statut', type: 'select', options: ['À faire', 'En cours', 'Fait'] },
            { id: uuidv7(), name: 'Priorité', type: 'number' },
          ],
        },
        view: { id: uuidv7(), layout: 'table', filters: [], sorts: [] },
        rowIds: [],
      };
      ws.collections.push(rec);
      addRowTo(rec);
      addRowTo(rec);
      notify();
      return { collectionId: rec.schema.id };
    },

    addRow(collectionId) {
      const rec = record(collectionId);
      if (!rec) return;
      addRowTo(rec);
      notify();
    },

    deleteRow(collectionId, pageId) {
      const rec = record(collectionId);
      if (!rec) return;
      rec.rowIds = rec.rowIds.filter((id) => id !== pageId);
      ws.pages = ws.pages.filter((p) => p.id !== pageId);
      notify();
    },

    updateCell(collectionId, pageId, propertyId, value) {
      const page = ws.pages.find((p) => p.id === pageId);
      if (!page) return;
      const properties = { ...((page.props?.['properties'] as Record<string, unknown>) ?? {}) };
      properties[propertyId] = value;
      page.props = { ...page.props, properties };
      notify();
    },

    addProperty(collectionId) {
      const rec = record(collectionId);
      if (!rec) return;
      const prop: PropertyDef = { id: uuidv7(), name: `Propriété ${rec.schema.properties.length + 1}`, type: 'text' };
      rec.schema.properties.push(prop);
      notify();
    },

    updateProperty(collectionId, prop) {
      const rec = record(collectionId);
      if (!rec) return;
      rec.schema.properties = rec.schema.properties.map((p) => (p.id === prop.id ? prop : p));
      notify();
    },

    deleteProperty(collectionId, propertyId) {
      const rec = record(collectionId);
      if (!rec) return;
      // non-destructive: row values stay in page props, ignored by renderers
      rec.schema.properties = rec.schema.properties.filter((p) => p.id !== propertyId);
      rec.view.filters = rec.view.filters.filter((f) => f.propertyId !== propertyId);
      rec.view.sorts = rec.view.sorts.filter((s) => s.propertyId !== propertyId);
      notify();
    },

    updateView(collectionId, view) {
      const rec = record(collectionId);
      if (!rec) return;
      rec.view = view;
      notify();
    },

    updateSchemaName(collectionId, name) {
      const rec = record(collectionId);
      if (!rec) return;
      rec.schema.name = name;
      notify();
    },

    openRow(pageId) {
      opts.openPage(pageId);
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
