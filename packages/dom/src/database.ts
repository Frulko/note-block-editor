import type { Block, CollectionSchema, PropertyDef, RowData, ViewConfig } from '@nbe/core';
import { applyView, formatValue, PROPERTY_TYPES } from '@nbe/core';
import type { EditorView } from './view';
import { createMenu, type MenuEntry } from './ui';
import { renderBlock } from './render';

export interface DatabaseData {
  schema: CollectionSchema;
  view: ViewConfig;
  rows: RowData[];
}

/** Workspace-side contract: collections, views and row pages live in the host. */
export interface DatabaseHost {
  get(collectionId: string): DatabaseData | null;
  create(): { collectionId: string } | null;
  addRow(collectionId: string): void;
  deleteRow(collectionId: string, pageId: string): void;
  updateCell(collectionId: string, pageId: string, propertyId: string, value: unknown): void;
  addProperty(collectionId: string): void;
  updateProperty(collectionId: string, prop: PropertyDef): void;
  deleteProperty(collectionId: string, propertyId: string): void;
  updateView(collectionId: string, view: ViewConfig): void;
  updateSchemaName?(collectionId: string, name: string): void;
  openRow(pageId: string): void;
  onChange(cb: () => void): () => void;
}

const FILTER_OPS: Array<{ op: ViewConfig['filters'][number]['op']; label: string; needsValue: boolean }> = [
  { op: 'contains', label: 'contient', needsValue: true },
  { op: 'eq', label: 'est', needsValue: true },
  { op: 'neq', label: "n'est pas", needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'not_empty', label: 'non vide', needsValue: false },
  { op: 'empty', label: 'vide', needsValue: false },
];

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(className: string, text: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Swap a cell's content for an input; commit on Enter/blur, cancel on Escape. */
function inlineInput(
  cell: HTMLElement,
  initial: string,
  commit: (value: string) => void,
  inputType = 'text',
): void {
  const input = document.createElement('input');
  input.type = inputType;
  input.className = 'nbe-db-input';
  input.value = initial;
  cell.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) commit(input.value);
    else cell.textContent = initial;
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      input.blur();
    }
    e.stopPropagation();
  });
}

export function renderDatabase(view: EditorView, block: Block): HTMLElement {
  const host = view.options.database;
  const root = el('div', 'nbe-db');
  root.dataset['nbeUi'] = '';
  root.setAttribute('contenteditable', 'false');
  const collectionId = String(block.props['collectionId'] ?? '');
  const data = host?.get(collectionId);
  if (!host || !data) {
    root.append(el('div', 'nbe-db-missing', '🗃️ Base de données indisponible'));
    return root;
  }
  const { schema, view: cfg } = data;
  const rows = applyView(data.rows, cfg, schema);

  // --- toolbar ---
  const toolbar = el('div', 'nbe-db-toolbar');
  const title = el('span', 'nbe-db-title', schema.name);
  title.addEventListener('dblclick', () =>
    inlineInput(title, schema.name, (v) => host.updateSchemaName?.(collectionId, v.trim() || schema.name)),
  );
  const filterBtn = btn('nbe-db-tool', cfg.filters.length ? `Filtre (${cfg.filters.length})` : 'Filtrer', () =>
    openFilterMenu(filterBtn),
  );
  const sortBtn = btn('nbe-db-tool', cfg.sorts.length ? `Tri (${cfg.sorts.length})` : 'Trier', () =>
    openSortMenu(sortBtn),
  );
  toolbar.append(title, el('span', 'nbe-db-spacer'), filterBtn, sortBtn);
  root.append(toolbar);

  // --- menus ---
  const openSortMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const entries: MenuEntry[] = [];
    if (cfg.sorts.length)
      entries.push({ label: 'Aucun tri', onSelect: () => host.updateView(collectionId, { ...cfg, sorts: [] }) });
    const cols: Array<{ id: string; name: string }> = [{ id: 'title', name: 'Titre' }, ...schema.properties];
    for (const c of cols) {
      const active = cfg.sorts[0]?.propertyId === c.id ? cfg.sorts[0].dir : null;
      entries.push({
        label: `${c.name} ↑`,
        hint: active === 'asc' ? '✓' : undefined,
        onSelect: () => host.updateView(collectionId, { ...cfg, sorts: [{ propertyId: c.id, dir: 'asc' }] }),
      });
      entries.push({
        label: `${c.name} ↓`,
        hint: active === 'desc' ? '✓' : undefined,
        onSelect: () => host.updateView(collectionId, { ...cfg, sorts: [{ propertyId: c.id, dir: 'desc' }] }),
      });
    }
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  const openFilterMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const wrap = el('div', 'nbe-db-filter');
    const propSel = document.createElement('select');
    for (const c of [{ id: 'title', name: 'Titre' }, ...schema.properties]) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      propSel.append(o);
    }
    const opSel = document.createElement('select');
    for (const o of FILTER_OPS) {
      const opt = document.createElement('option');
      opt.value = o.op;
      opt.textContent = o.label;
      opSel.append(opt);
    }
    const valInput = document.createElement('input');
    valInput.className = 'nbe-db-input';
    valInput.placeholder = 'valeur';
    const current = cfg.filters[0];
    if (current) {
      propSel.value = current.propertyId;
      opSel.value = current.op;
      valInput.value = String(current.value ?? '');
    }
    const syncVal = () => {
      valInput.style.display = FILTER_OPS.find((o) => o.op === opSel.value)?.needsValue ? '' : 'none';
    };
    opSel.addEventListener('change', syncVal);
    syncVal();
    wrap.append(propSel, opSel, valInput);
    const entries: MenuEntry[] = [
      { kind: 'custom', el: wrap },
      {
        label: 'Appliquer',
        onSelect: () =>
          host.updateView(collectionId, {
            ...cfg,
            filters: [{ propertyId: propSel.value, op: opSel.value as never, value: valInput.value }],
          }),
      },
    ];
    if (cfg.filters.length)
      entries.push({ label: 'Effacer le filtre', onSelect: () => host.updateView(collectionId, { ...cfg, filters: [] }) });
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  const openPropertyMenu = (anchor: HTMLElement, prop: PropertyDef) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const nameWrap = el('div', 'nbe-db-filter');
    const nameInput = document.createElement('input');
    nameInput.className = 'nbe-db-input';
    nameInput.value = prop.name;
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        menu.close();
        host.updateProperty(collectionId, { ...prop, name: nameInput.value.trim() || prop.name });
      }
      e.stopPropagation();
    });
    nameWrap.append(nameInput);
    const entries: MenuEntry[] = [
      { kind: 'custom', el: nameWrap },
      { kind: 'section', label: 'Type' },
      ...PROPERTY_TYPES.map((t) => ({
        label: t.label,
        hint: prop.type === t.type ? '✓' : undefined,
        onSelect: () => host.updateProperty(collectionId, { ...prop, type: t.type }),
      })),
      { kind: 'section', label: ' ' },
      { label: 'Supprimer la propriété', onSelect: () => host.deleteProperty(collectionId, prop.id) },
    ];
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  const openSelectMenu = (anchor: HTMLElement, prop: PropertyDef, row: RowData, multi: boolean) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const currentRaw = row.properties[prop.id];
    const selected = multi
      ? new Set(Array.isArray(currentRaw) ? currentRaw.map(String) : [])
      : new Set(currentRaw !== undefined && currentRaw !== '' ? [String(currentRaw)] : []);
    const entries: MenuEntry[] = (prop.options ?? []).map((opt) => ({
      label: opt,
      hint: selected.has(opt) ? '✓' : undefined,
      onSelect: () => {
        if (multi) {
          const next = new Set(selected);
          if (next.has(opt)) next.delete(opt);
          else next.add(opt);
          host.updateCell(collectionId, row.pageId, prop.id, [...next]);
        } else {
          host.updateCell(collectionId, row.pageId, prop.id, selected.has(opt) ? '' : opt);
        }
      },
    }));
    const addWrap = el('div', 'nbe-db-filter');
    const addInput = document.createElement('input');
    addInput.className = 'nbe-db-input';
    addInput.placeholder = '＋ nouvelle option…';
    addInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = addInput.value.trim();
      if (!value) return;
      menu.close();
      host.updateProperty(collectionId, { ...prop, options: [...(prop.options ?? []), value] });
      host.updateCell(collectionId, row.pageId, prop.id, multi ? [...selected, value] : value);
    });
    addWrap.append(addInput);
    entries.push({ kind: 'custom', el: addWrap });
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  // --- table ---
  const table = el('div', 'nbe-db-table');
  const head = el('div', 'nbe-db-row nbe-db-head');
  head.append(el('div', 'nbe-db-cell nbe-db-titlecol', 'Titre'));
  for (const prop of schema.properties) {
    const cell = el('div', 'nbe-db-cell nbe-db-headcell', prop.name);
    cell.addEventListener('click', () => openPropertyMenu(cell, prop));
    head.append(cell);
  }
  head.append(btn('nbe-db-cell nbe-db-addprop', '＋', () => host.addProperty(collectionId)));
  table.append(head);

  for (const row of rows) {
    const tr = el('div', 'nbe-db-row');
    const titleCell = el('div', 'nbe-db-cell nbe-db-titlecol nbe-db-titlecell');
    titleCell.append('📄 ', row.title || 'Sans titre');
    titleCell.addEventListener('click', () => host.openRow(row.pageId));
    tr.append(titleCell);

    for (const prop of schema.properties) {
      const cell = el('div', 'nbe-db-cell');
      const value = row.properties[prop.id];
      switch (prop.type) {
        case 'checkbox': {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = value === true;
          cb.addEventListener('change', () => host.updateCell(collectionId, row.pageId, prop.id, cb.checked));
          cell.append(cb);
          break;
        }
        case 'date': {
          const d = document.createElement('input');
          d.type = 'date'; // native picker (the ladder)
          d.className = 'nbe-db-date';
          d.value = String(value ?? '');
          d.addEventListener('change', () => host.updateCell(collectionId, row.pageId, prop.id, d.value));
          cell.append(d);
          break;
        }
        case 'select':
        case 'multi_select': {
          const label = formatValue(value, prop.type) || '—';
          const b = btn('nbe-db-selectbtn', label, () =>
            openSelectMenu(b, prop, row, prop.type === 'multi_select'),
          );
          cell.append(b);
          break;
        }
        default: {
          cell.textContent = formatValue(value, prop.type);
          cell.classList.add('nbe-db-editable');
          cell.addEventListener('click', () =>
            inlineInput(
              cell,
              String(value ?? ''),
              (v) =>
                host.updateCell(
                  collectionId,
                  row.pageId,
                  prop.id,
                  prop.type === 'number' ? (v.trim() === '' ? '' : Number(v)) : v,
                ),
              prop.type === 'number' ? 'number' : 'text',
            ),
          );
        }
      }
      tr.append(cell);
    }
    const rowMenuBtn = btn('nbe-db-cell nbe-db-rowmenu', '⋯', () => {
      const menu = createMenu({ className: 'nbe-db-menu' });
      menu.update([
        { label: 'Ouvrir', onSelect: () => host.openRow(row.pageId) },
        { label: 'Supprimer la ligne', onSelect: () => host.deleteRow(collectionId, row.pageId) },
      ]);
      menu.open(() => rowMenuBtn.getBoundingClientRect(), { placement: 'bottom-end' });
    });
    tr.append(rowMenuBtn);
    table.append(tr);
  }

  table.append(btn('nbe-db-newrow', '＋ Nouveau', () => host.addRow(collectionId)));
  root.append(table);
  return root;
}

/** Re-render database blocks when the host data changes. */
export function attachDatabaseBlocks(view: EditorView): () => void {
  const host = view.options.database;
  if (!host) return () => {};
  return host.onChange(() => {
    for (const eln of view.content.querySelectorAll<HTMLElement>('.nbe-block.nbe-t-database')) {
      const id = eln.dataset['blockId'];
      if (id && view.editor.doc.blocks.has(id)) eln.replaceWith(renderBlock(view, id));
    }
  });
}
