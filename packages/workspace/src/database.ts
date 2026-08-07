import {
  uuidv7,
  type BlockJSON,
  type CollectionSchema,
  type DatabaseData,
  type DatabaseHost,
  type PropertyDef,
  type RowData,
  type ViewConfig,
} from '@nbe/core';
import { pageTitle, type Workspace } from './index';

/**
 * Databases over a workspace — §2.5's four records, wired up once.
 *
 * @remarks
 * A view *block* places a database in a page; a *view* holds layout, filters
 * and sorts; a *schema* holds typed properties; and the *rows are pages*. Only
 * the first is a block, so the other three belong to whoever owns the
 * workspace — which is this.
 *
 * **Rows are derived, not listed.** A page belongs to a collection because its
 * own `props.collectionId` says so, and that is the only place it is written.
 * The implementation this replaces also kept a `rowIds` array on the
 * collection record, which is the same fact stored twice: delete a row page
 * and the array still names it, import rows and the array must be updated in
 * step. Deriving costs a filter over the pages and cannot disagree with
 * itself.
 *
 * **Mutations apply now and persist after.** The editor's contract is
 * synchronous — `addRow` returns nothing — while a workspace write is not. So
 * the change lands in memory, listeners fire immediately, and the write is
 * kicked off behind it. A failed write is reported rather than swallowed,
 * because a database edit that looks applied and is not is the worst of the
 * available failures.
 *
 * @category Databases
 */

/** A collection's two workspace-level records, kept together. */
export interface CollectionRecord {
  schema: CollectionSchema;
  view: ViewConfig;
}

/**
 * Where collection schemas and views are kept.
 *
 * @remarks
 * Separate from {@link WorkspaceStorage}, which is deliberately four methods
 * about *pages* and nothing else. These are workspace-level records: a handful
 * of small objects, read once and rewritten whole. A file backend puts them in
 * one JSON file beside the pages; a browser puts them wherever it keeps its
 * settings.
 */
export interface CollectionStore {
  read(): Promise<CollectionRecord[]>;
  write(records: CollectionRecord[]): Promise<void>;
}

export interface DatabaseHostOptions {
  /** Open a row page in the editor. */
  openPage: (pageId: string) => void;
  /** Something changed: re-render whatever shows the workspace. */
  onMutate?: () => void;
  /** A persist failed. Default: log it, because silence is worse. */
  onError?: (error: unknown) => void;
}

/** A store that keeps records in memory. Useful in tests and scratch apps. */
export function memoryCollections(initial: CollectionRecord[] = []): CollectionStore {
  let records = initial;
  return {
    read: async () => records,
    write: async (next) => void (records = next),
  };
}

function defaultProperty(index: number): PropertyDef {
  return { id: uuidv7(), name: `Propriété ${index + 1}`, type: 'text' };
}

/**
 * Build the host the editor asks for.
 *
 * @param workspace - A loaded workspace. Rows are pages in it.
 * @param records - The collections, already read from a {@link CollectionStore}.
 * @param store - Where to write them back.
 */
export function createDatabaseHost(
  workspace: Workspace,
  records: CollectionRecord[],
  store: CollectionStore,
  opts: DatabaseHostOptions,
): DatabaseHost {
  const listeners = new Set<() => void>();
  const report = opts.onError ?? ((error: unknown) => console.error('[workspace] écriture échouée', error));

  /** Apply now, persist behind, tell everyone. */
  const commit = (work?: () => Promise<void>): void => {
    void store.write(records).catch(report);
    if (work) void work().catch(report);
    opts.onMutate?.();
    for (const listener of listeners) listener();
  };

  const find = (collectionId: string): CollectionRecord | undefined =>
    records.find((record) => record.schema.id === collectionId);

  /** A collection's rows, in creation order — uuidv7 sorts by time. */
  const rowsOf = (collectionId: string): RowData[] =>
    workspace.pages
      .map((node) => ({ node, doc: workspace.document(node.id) }))
      .filter((entry): entry is { node: typeof entry.node; doc: BlockJSON } =>
        entry.doc?.props?.['collectionId'] === collectionId,
      )
      .sort((a, b) => (a.node.id < b.node.id ? -1 : 1))
      .map(({ node, doc }) => ({
        pageId: node.id,
        title: String(doc.props?.['title'] ?? '') || pageTitle(doc),
        properties: (doc.props?.['properties'] ?? {}) as Record<string, unknown>,
      }));

  /** Edit a row page's own props, which is where a row's data lives. */
  const editRow = async (pageId: string, edit: (props: Record<string, unknown>) => void): Promise<void> => {
    const doc = workspace.document(pageId);
    if (!doc) return;
    doc.props = { ...doc.props };
    edit(doc.props);
    await workspace.save(pageId, doc);
  };

  return {
    get(collectionId): DatabaseData | null {
      const record = find(collectionId);
      return record ? { schema: record.schema, view: record.view, rows: rowsOf(collectionId) } : null;
    },

    create() {
      const schema: CollectionSchema = {
        id: uuidv7(),
        name: 'Base',
        properties: [defaultProperty(0)],
      };
      const view: ViewConfig = { id: uuidv7(), layout: 'table', filters: [], sorts: [] };
      records.push({ schema, view });
      commit();
      return { collectionId: schema.id };
    },

    addRow(collectionId, initialProperties = {}) {
      if (!find(collectionId)) return;
      commit(async () => {
        const pageId = await workspace.createPage({ title: '' });
        await editRow(pageId, (props) => {
          props['collectionId'] = collectionId;
          props['properties'] = initialProperties;
        });
        opts.onMutate?.();
        for (const listener of listeners) listener();
      });
    },

    deleteRow(_collectionId, pageId) {
      commit(async () => {
        await workspace.deletePage(pageId);
        opts.onMutate?.();
        for (const listener of listeners) listener();
      });
    },

    updateCell(_collectionId, pageId, propertyId, value) {
      commit(() =>
        editRow(pageId, (props) => {
          props['properties'] = { ...(props['properties'] as object), [propertyId]: value };
        }),
      );
    },

    addProperty(collectionId) {
      const record = find(collectionId);
      if (!record) return;
      record.schema.properties.push(defaultProperty(record.schema.properties.length));
      commit();
    },

    updateProperty(collectionId, prop) {
      const record = find(collectionId);
      if (!record) return;
      const at = record.schema.properties.findIndex((property) => property.id === prop.id);
      if (at < 0) return;
      record.schema.properties[at] = prop;
      commit();
    },

    deleteProperty(collectionId, propertyId) {
      const record = find(collectionId);
      if (!record) return;
      record.schema.properties = record.schema.properties.filter((property) => property.id !== propertyId);
      /*
       * The values stay on the row pages. A deleted property is usually a
       * mistake, and a column that comes back empty is worse than one that
       * comes back — nothing else reads a value whose property is gone.
       */
      commit();
    },

    updateView(collectionId, view) {
      const record = find(collectionId);
      if (!record) return;
      record.view = view;
      commit();
    },

    updateSchemaName(collectionId, name) {
      const record = find(collectionId);
      if (!record) return;
      record.schema.name = name;
      commit();
    },

    listCollections() {
      return records.map((record) => ({ id: record.schema.id, name: record.schema.name }));
    },

    importRows(collectionId, rows) {
      if (!find(collectionId)) return;
      commit(async () => {
        for (const row of rows) {
          const pageId = await workspace.createPage({ title: row.title });
          await editRow(pageId, (props) => {
            props['collectionId'] = collectionId;
            props['properties'] = row.properties;
          });
        }
        opts.onMutate?.();
        for (const listener of listeners) listener();
      });
    },

    openRow(pageId) {
      opts.openPage(pageId);
    },

    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
