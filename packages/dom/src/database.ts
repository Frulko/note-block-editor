import type {
  Block,
  CollectionSchema,
  Filter,
  FilterOp,
  PropertyDef,
  RowData,
  RowGroup,
  ViewConfig,
  ViewLayout,
} from '@nbe/core';
import {
  evaluateView,
  formatValue,
  FORMULA_FUNCTION_NAMES,
  parseFormula,
  PROPERTY_TYPES,
  relationIds,
  ROLLUP_FNS,
  visibleProperties,
} from '@nbe/core';
import type { EditorView } from './view';
import { collectionToCsv, csvToRows, safeName, viewToBase } from '@nbe/markdown/collections';
import {
  createCheckbox,
  createDragGhost,
  createMenu,
  createSelect,
  createTextInput,
  draggable,
  editInline,
  pickFile,
  type DragGhost,
  type MenuEntry,
} from './ui';
import { renderBlock } from './render';

// the contract lives in core (§2.5): the editor consumes it, and an
// application over `@nbe/workspace` implements it
export type { DatabaseData, DatabaseHost } from '@nbe/core';

const FILTER_OPS: Array<{ op: FilterOp; label: string; needsValue: boolean }> = [
  { op: 'contains', label: 'contient', needsValue: true },
  { op: 'eq', label: 'est', needsValue: true },
  { op: 'neq', label: "n'est pas", needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'not_empty', label: 'non vide', needsValue: false },
  { op: 'empty', label: 'vide', needsValue: false },
];

const LAYOUTS: Array<{ layout: ViewLayout; label: string; icon: string }> = [
  { layout: 'table', label: 'Table', icon: '▤' },
  { layout: 'board', label: 'Board', icon: '▥' },
  { layout: 'list', label: 'Liste', icon: '☰' },
  { layout: 'gallery', label: 'Galerie', icon: '▦' },
];

const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s]*)?$/i;

const PAGE_SIZE = 50;

/**
 * How much of each view has been scrolled into existence. It lives outside the
 * render because the host replaces the whole database block on every change:
 * without it, editing a cell on row 400 would snap the view back to row 1.
 */
const renderedCounts = new Map<string, number>();

/**
 * Progressive rendering rather than true windowing. The first page paints
 * immediately and a sentinel appends the next as it scrolls into view, so a
 * ten-thousand-row collection costs one page at first paint. Memory still
 * grows with what has actually been looked at — the trade that keeps native
 * scrolling, find-in-page and text selection working, which a windowed list
 * with absolute positioning and estimated heights gives up.
 */
function paginate<T>(
  container: HTMLElement,
  items: T[],
  key: string,
  render: (item: T) => HTMLElement,
): void {
  const sentinel = el('div', 'nbe-db-sentinel');
  let shown = 0;

  /** Render up to `upTo` items, keeping the sentinel last. Returns true at the end. */
  const growTo = (upTo: number): boolean => {
    const next = Math.min(items.length, upTo);
    for (const item of items.slice(shown, next)) container.insertBefore(render(item), sentinel);
    shown = next;
    renderedCounts.set(key, shown);
    return shown >= items.length;
  };

  container.append(sentinel);
  // restore how far the user had scrolled before the re-render, never less than a page
  if (growTo(Math.max(PAGE_SIZE, renderedCounts.get(key) ?? 0))) {
    sentinel.remove();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    if (growTo(shown + PAGE_SIZE)) {
      observer.disconnect();
      sentinel.remove();
    }
  });
  observer.observe(sentinel);
}

/** Exposed for tests only — pagination is an internal rendering detail. */
export { paginate as __paginate };

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
  const columns = visibleProperties(schema, cfg);
  // computed properties resolve against other collections through the host
  const computeCtx = {
    relatedRows: (id: string) => host.get(id)?.rows ?? [],
    relatedSchema: (id: string) => host.get(id)?.schema ?? null,
  };
  const { rows, groups } = evaluateView(data.rows, cfg, schema, computeCtx);
  const allColumns = (): Array<{ id: string; name: string }> => [{ id: 'title', name: 'Titre' }, ...schema.properties];
  const patchView = (patch: Partial<ViewConfig>) => host.updateView(collectionId, { ...cfg, ...patch });
  /** Identifies one scrollable list of rows, so its rendered depth survives re-renders. */
  const pageKey = (layout: string, group = '') => `${collectionId}/${cfg.id}/${layout}/${group}`;

  // ---------------------------------------------------------------- toolbar
  const toolbar = el('div', 'nbe-db-toolbar');
  const title = el('span', 'nbe-db-title', schema.name);
  title.title = 'Double-clic pour renommer';
  title.addEventListener('dblclick', () =>
    editInline(title, schema.name, (v) => host.updateSchemaName?.(collectionId, v.trim() || schema.name)),
  );

  /** First property a board can meaningfully group by. */
  const firstGroupable = (): string | undefined =>
    schema.properties.find((p) => p.type === 'select' || p.type === 'multi_select' || p.type === 'checkbox')?.id;

  const layoutSwitch = el('div', 'nbe-db-layouts');
  for (const l of LAYOUTS) {
    const b = btn(
      'nbe-db-layout' + (cfg.layout === l.layout ? ' nbe-active' : ''),
      `${l.icon} ${l.label}`,
      () => patchView({ layout: l.layout, ...(l.layout === 'board' && !cfg.groupBy ? { groupBy: firstGroupable() } : {}) }),
    );
    b.title = l.label;
    layoutSwitch.append(b);
  }

  const filterBtn = btn('nbe-db-tool', cfg.filters.length ? `Filtres (${cfg.filters.length})` : 'Filtrer', () =>
    openFilterMenu(filterBtn),
  );
  const sortBtn = btn('nbe-db-tool', cfg.sorts.length ? `Tris (${cfg.sorts.length})` : 'Trier', () => openSortMenu(sortBtn));
  const groupBtn = btn(
    'nbe-db-tool' + (cfg.groupBy ? ' nbe-active' : ''),
    cfg.groupBy ? `Groupe : ${allColumns().find((c) => c.id === cfg.groupBy)?.name ?? '—'}` : 'Grouper',
    () => openGroupMenu(groupBtn),
  );
  const propsBtn = btn('nbe-db-tool', 'Propriétés', () => openPropsMenu(propsBtn));
  const exportBtn = btn('nbe-db-tool', '⋯', () => openExportMenu(exportBtn));
  exportBtn.title = 'Exporter / importer';
  toolbar.append(title, layoutSwitch, el('span', 'nbe-db-spacer'), propsBtn, groupBtn, filterBtn, sortBtn, exportBtn);
  root.append(toolbar);

  // ------------------------------------------------------------------ menus
  const openSortMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const entries: MenuEntry[] = [];
    if (cfg.sorts.length) {
      entries.push({ kind: 'section', label: 'Tris actifs' });
      cfg.sorts.forEach((sort, i) => {
        const name = allColumns().find((c) => c.id === sort.propertyId)?.name ?? sort.propertyId;
        entries.push({
          label: `${i + 1}. ${name} ${sort.dir === 'asc' ? '↑' : '↓'}`,
          hint: '✕',
          onSelect: () => patchView({ sorts: cfg.sorts.filter((_, j) => j !== i) }),
        });
      });
      entries.push({ label: 'Tout effacer', onSelect: () => patchView({ sorts: [] }) });
    }
    entries.push({ kind: 'section', label: 'Ajouter un tri' });
    for (const c of allColumns()) {
      for (const dir of ['asc', 'desc'] as const) {
        entries.push({
          label: `${c.name} ${dir === 'asc' ? '↑' : '↓'}`,
          onSelect: () =>
            patchView({ sorts: [...cfg.sorts.filter((s) => s.propertyId !== c.id), { propertyId: c.id, dir }] }),
        });
      }
    }
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-end' });
  };

  const openFilterMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu nbe-db-filtermenu' });
    const entries: MenuEntry[] = [];

    cfg.filters.forEach((filter, i) => {
      const row = el('div', 'nbe-db-filter');
      const propSel = createSelect({ options: allColumns().map((c) => ({ value: c.id, label: c.name })), value: filter.propertyId }).input;
      const opSel = createSelect({ options: FILTER_OPS.map((o) => ({ value: o.op, label: o.label })), value: filter.op }).input;
      const commit = () => {
        const next = [...cfg.filters];
        next[i] = { propertyId: propSel.value, op: opSel.value as FilterOp, value: valField.value() };
        patchView({ filters: next });
      };
      // the field owns Enter, blur and Escape; this row only says what to do
      const valField = createTextInput({
        value: String(filter.value ?? ''),
        placeholder: 'valeur',
        onCommit: commit,
      });
      const syncVis = () => {
        valField.el.style.display = FILTER_OPS.find((o) => o.op === opSel.value)?.needsValue ? '' : 'none';
      };
      syncVis();
      propSel.addEventListener('change', commit);
      opSel.addEventListener('change', () => {
        syncVis();
        commit();
      });
      row.append(propSel, opSel, valField.el, btn('nbe-db-x', '✕', () => patchView({ filters: cfg.filters.filter((_, j) => j !== i) })));
      entries.push({ kind: 'custom', el: row });
    });

    entries.push({
      label: '＋ Ajouter un filtre',
      onSelect: () =>
        patchView({
          filters: [...cfg.filters, { propertyId: allColumns()[0]!.id, op: 'contains', value: '' }],
        }),
    });
    if (cfg.filters.length) entries.push({ label: 'Tout effacer', onSelect: () => patchView({ filters: [] }) });
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-end' });
  };

  const openGroupMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const entries: MenuEntry[] = [
      { label: 'Aucun groupe', hint: cfg.groupBy ? undefined : '✓', onSelect: () => patchView({ groupBy: undefined }) },
      { kind: 'section', label: 'Grouper par' },
      ...allColumns().map((c) => ({
        label: c.name,
        hint: cfg.groupBy === c.id ? '✓' : undefined,
        onSelect: () => patchView({ groupBy: c.id }),
      })),
    ];
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-end' });
  };

  const openPropsMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const hidden = new Set(cfg.hidden ?? []);
    const entries: MenuEntry[] = [
      { kind: 'section', label: 'Afficher' },
      ...schema.properties.map((p) => ({
        label: p.name,
        hint: hidden.has(p.id) ? '○' : '●',
        onSelect: () =>
          patchView({
            hidden: hidden.has(p.id) ? [...hidden].filter((id) => id !== p.id) : [...hidden, p.id],
          }),
      })),
      { label: '＋ Nouvelle propriété', onSelect: () => host.addProperty(collectionId) },
    ];
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-end' });
  };

  /**
   * "Readable without the tool" applied to databases (ARCHITECTURE §10):
   * the collection projects to CSV and to an Obsidian-Bases-shaped view.
   */
  const openExportMenu = (anchor: HTMLElement) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const download = (name: string, content: string, mime: string) => {
      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const entries: MenuEntry[] = [
      {
        label: 'Copier en CSV',
        onSelect: () => void navigator.clipboard?.writeText(collectionToCsv(rows, schema)),
      },
      {
        label: 'Télécharger le CSV',
        onSelect: () => download(`${safeName(schema.name)}.csv`, collectionToCsv(rows, schema), 'text/csv'),
      },
      {
        label: 'Télécharger la vue (.base)',
        onSelect: () => download(`${safeName(schema.name)}.base`, viewToBase(schema, cfg), 'text/yaml'),
      },
    ];
    if (host.importRows) {
      entries.push({
        label: 'Importer un CSV…',
        onSelect: () => {
          void pickFile('.csv,text/csv').then(async (file) => {
            if (!file) return;
            const { rows: imported, unknownColumns } = csvToRows(await file.text(), schema);
            if (imported.length) host.importRows!(collectionId, imported);
            if (unknownColumns.length) {
              view.announce(`Colonnes ignorées : ${unknownColumns.join(', ')}`);
            }
          });
        },
      });
    }
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-end' });
  };

  const openPropertyMenu = (anchor: HTMLElement, prop: PropertyDef) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const nameWrap = el('div', 'nbe-db-filter');
    const nameField = createTextInput({
      value: prop.name,
      onCommit: (v) => {
        menu.close();
        host.updateProperty(collectionId, { ...prop, name: v.trim() || prop.name });
      },
    });
    nameWrap.append(nameField.el);
    const entries: MenuEntry[] = [
      { kind: 'custom', el: nameWrap },
      { label: 'Trier ↑', onSelect: () => patchView({ sorts: [{ propertyId: prop.id, dir: 'asc' }] }) },
      { label: 'Trier ↓', onSelect: () => patchView({ sorts: [{ propertyId: prop.id, dir: 'desc' }] }) },
      { label: 'Grouper par', onSelect: () => patchView({ groupBy: prop.id }) },
      { label: 'Masquer', onSelect: () => patchView({ hidden: [...(cfg.hidden ?? []), prop.id] }) },
    ];

    if (prop.type === 'formula') {
      entries.push({ kind: 'section', label: 'Formule' }, { kind: 'custom', el: formulaEditor(prop, menu) });
    }
    if (prop.type === 'relation') {
      entries.push({ kind: 'section', label: 'Collection cible' });
      for (const c of host.listCollections?.() ?? []) {
        if (c.id === collectionId) continue; // self-relations need a UI of their own
        entries.push({
          label: c.name,
          hint: prop.relation?.collectionId === c.id ? '✓' : undefined,
          onSelect: () => host.updateProperty(collectionId, { ...prop, relation: { collectionId: c.id } }),
        });
      }
    }
    if (prop.type === 'rollup') entries.push(...rollupConfigEntries(prop));

    entries.push(
      { kind: 'section', label: 'Type' },
      ...PROPERTY_TYPES.map((t) => ({
        label: t.label,
        hint: prop.type === t.type ? '✓' : undefined,
        onSelect: () => host.updateProperty(collectionId, { ...prop, type: t.type }),
      })),
      { kind: 'section', label: ' ' },
      { label: 'Supprimer la propriété', onSelect: () => host.deleteProperty(collectionId, prop.id) },
    );
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  /** Formula source editor with live parse feedback. */
  const formulaEditor = (prop: PropertyDef, menu: { close: () => void }): HTMLElement => {
    const wrap = el('div', 'nbe-db-formula');
    const status = el('div', 'nbe-db-formulastatus');

    /** Parse feedback: the error goes on the field, the success note beside it. */
    const validate = (source: string): string | null => {
      if (!source.trim()) return null;
      try {
        parseFormula(source);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'Formule invalide';
      }
    };

    const field = createTextInput({
      multiline: true,
      value: prop.formula ?? '',
      placeholder: 'ex: prop("Prix") * prop("Quantité")',
      className: 'nbe-db-formulafield',
      onInput: (source) => {
        const error = validate(source);
        field.setError(error);
        status.textContent = error || !source.trim() ? '' : '✓ formule valide';
      },
      // multiline fields do not commit on Enter, so the editor drives it
      onCommit: (source) => validate(source) ?? undefined,
    });

    field.input.addEventListener('keydown', (e) => {
      const event = e as KeyboardEvent;
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      const source = field.value();
      const error = validate(source);
      field.setError(error);
      if (error) return;
      menu.close();
      host.updateProperty(collectionId, { ...prop, formula: source });
    });

    const help = el('div', 'nbe-db-formulahelp', `Entrée pour valider · ${FORMULA_FUNCTION_NAMES.join(', ')}`);
    wrap.append(field.el, status, help);
    return wrap;
  };

  const rollupConfigEntries = (prop: PropertyDef): MenuEntry[] => {
    const relations = schema.properties.filter((p) => p.type === 'relation');
    const config = prop.rollup;
    const targetCollection = relations.find((r) => r.id === config?.relationPropertyId)?.relation?.collectionId;
    const targetSchema = targetCollection ? host.get(targetCollection)?.schema : null;
    const out: MenuEntry[] = [{ kind: 'section', label: 'Relation source' }];
    if (!relations.length) {
      out.push({ label: 'Crée d’abord une propriété Relation', onSelect: () => {} });
      return out;
    }
    for (const rel of relations) {
      out.push({
        label: rel.name,
        hint: config?.relationPropertyId === rel.id ? '✓' : undefined,
        onSelect: () =>
          host.updateProperty(collectionId, {
            ...prop,
            rollup: { relationPropertyId: rel.id, targetPropertyId: 'title', fn: config?.fn ?? 'count' },
          }),
      });
    }
    if (config?.relationPropertyId) {
      out.push({ kind: 'section', label: 'Propriété agrégée' });
      for (const target of [{ id: 'title', name: 'Titre' }, ...(targetSchema?.properties ?? [])]) {
        out.push({
          label: target.name,
          hint: config.targetPropertyId === target.id ? '✓' : undefined,
          onSelect: () =>
            host.updateProperty(collectionId, { ...prop, rollup: { ...config, targetPropertyId: target.id } }),
        });
      }
      out.push({ kind: 'section', label: 'Calcul' });
      for (const r of ROLLUP_FNS) {
        out.push({
          label: r.label,
          hint: config.fn === r.fn ? '✓' : undefined,
          onSelect: () => host.updateProperty(collectionId, { ...prop, rollup: { ...config, fn: r.fn } }),
        });
      }
    }
    return out;
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
    const addField = createTextInput({
      placeholder: '＋ nouvelle option…',
      onCommit: (raw) => {
        const value = raw.trim();
        if (!value) return;
        menu.close();
        host.updateProperty(collectionId, { ...prop, options: [...(prop.options ?? []), value] });
        host.updateCell(collectionId, row.pageId, prop.id, multi ? [...selected, value] : value);
      },
    });
    addWrap.append(addField.el);
    entries.push({ kind: 'custom', el: addWrap });
    menu.update(entries);
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  const openRelationMenu = (anchor: HTMLElement, prop: PropertyDef, row: RowData) => {
    const menu = createMenu({ className: 'nbe-db-menu' });
    const targetId = prop.relation?.collectionId;
    if (!targetId) {
      menu.update([{ label: 'Choisis une collection cible dans le menu de la propriété', onSelect: () => {} }]);
      menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
      return;
    }
    const selected = new Set(relationIds(row, prop.id));
    const targetRows = host.get(targetId)?.rows ?? [];
    menu.update(
      targetRows.length
        ? targetRows.map((target) => ({
            label: target.title || 'Sans titre',
            hint: selected.has(target.pageId) ? '✓' : undefined,
            onSelect: () => {
              const next = new Set(selected);
              if (next.has(target.pageId)) next.delete(target.pageId);
              else next.add(target.pageId);
              host.updateCell(collectionId, row.pageId, prop.id, [...next]);
            },
          }))
        : [{ label: 'La collection cible est vide', onSelect: () => {} }],
    );
    menu.open(() => anchor.getBoundingClientRect(), { placement: 'bottom-start' });
  };

  // ------------------------------------------------------------------ cells
  const renderCell = (row: RowData, prop: PropertyDef): HTMLElement => {
    const cell = el('div', 'nbe-db-cell');
    const value = row.properties[prop.id];
    switch (prop.type) {
      case 'checkbox': {
        const cb = createCheckbox({
          checked: value === true,
          onChange: (checked) => host.updateCell(collectionId, row.pageId, prop.id, checked),
        });
        cell.append(cb.el);
        break;
      }
      case 'date': {
        // native picker (the ladder)
        const d = createTextInput({
          type: 'date',
          value: String(value ?? ''),
          className: 'nbe-db-date',
          onCommit: (v) => host.updateCell(collectionId, row.pageId, prop.id, v),
        });
        d.input.addEventListener('change', () => host.updateCell(collectionId, row.pageId, prop.id, d.value()));
        cell.append(d.el);
        break;
      }
      case 'select':
      case 'multi_select': {
        const label = formatValue(value, prop.type) || '—';
        const b = btn('nbe-db-selectbtn', label, () => openSelectMenu(b, prop, row, prop.type === 'multi_select'));
        cell.append(b);
        break;
      }
      case 'formula':
      case 'rollup': {
        // derived: read-only by construction
        cell.classList.add('nbe-db-computed');
        cell.textContent = formatValue(value, prop.type);
        cell.title = prop.type === 'formula' ? (prop.formula ?? '') : 'Rollup';
        break;
      }
      case 'relation': {
        const targetId = prop.relation?.collectionId;
        const ids = relationIds(row, prop.id);
        const targetRows = targetId ? (host.get(targetId)?.rows ?? []) : [];
        const label =
          ids
            .map((id) => targetRows.find((r) => r.pageId === id)?.title || 'Sans titre')
            .join(', ') || '—';
        const b = btn('nbe-db-selectbtn', label, () => openRelationMenu(b, prop, row));
        cell.append(b);
        break;
      }
      case 'url': {
        const raw = String(value ?? '');
        if (raw) {
          const a = document.createElement('a');
          a.href = raw;
          a.target = '_blank';
          a.rel = 'noreferrer';
          a.textContent = raw;
          a.className = 'nbe-db-url';
          cell.append(a);
        }
        cell.classList.add('nbe-db-editable');
        cell.addEventListener('dblclick', () =>
          editInline(cell, raw, (v) => host.updateCell(collectionId, row.pageId, prop.id, v)),
        );
        break;
      }
      default: {
        cell.textContent = formatValue(value, prop.type);
        cell.classList.add('nbe-db-editable');
        cell.addEventListener('click', () =>
          editInline(
            cell,
            String(value ?? ''),
            (v) =>
              host.updateCell(
                collectionId,
                row.pageId,
                prop.id,
                prop.type === 'number' ? (v.trim() === '' ? '' : Number(v)) : v,
              ),
            { type: prop.type === 'number' ? 'number' : 'text' },
          ),
        );
      }
    }
    return cell;
  };

  // ------------------------------------------------------------------ table
  const tableRow = (row: RowData): HTMLElement => {
    const tr = el('div', 'nbe-db-row');
    const titleCell = el('div', 'nbe-db-cell nbe-db-titlecol nbe-db-titlecell');
    titleCell.append('📄 ', row.title || 'Sans titre');
    titleCell.addEventListener('click', () => host.openRow(row.pageId));
    tr.append(titleCell);
    for (const prop of columns) tr.append(renderCell(row, prop));
    const menuBtn = btn('nbe-db-cell nbe-db-rowmenu', '⋯', () => {
      const menu = createMenu({ className: 'nbe-db-menu' });
      menu.update([
        { label: 'Ouvrir', onSelect: () => host.openRow(row.pageId) },
        { label: 'Supprimer la ligne', onSelect: () => host.deleteRow(collectionId, row.pageId) },
      ]);
      menu.open(() => menuBtn.getBoundingClientRect(), { placement: 'bottom-end' });
    });
    tr.append(menuBtn);
    return tr;
  };

  const tableHead = (): HTMLElement => {
    const head = el('div', 'nbe-db-row nbe-db-head');
    head.append(el('div', 'nbe-db-cell nbe-db-titlecol', 'Titre'));
    for (const prop of columns) {
      const sort = cfg.sorts.find((s) => s.propertyId === prop.id);
      const cell = el('div', 'nbe-db-cell nbe-db-headcell', `${prop.name}${sort ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}`);
      cell.addEventListener('click', () => openPropertyMenu(cell, prop));
      head.append(cell);
    }
    head.append(btn('nbe-db-cell nbe-db-addprop', '＋', () => host.addProperty(collectionId)));
    return head;
  };

  const renderTable = (): HTMLElement => {
    const table = el('div', 'nbe-db-table');
    table.append(tableHead());
    if (groups) {
      for (const group of groups) {
        const header = el('div', 'nbe-db-groupheader');
        header.append(el('span', 'nbe-db-grouplabel', group.label), el('span', 'nbe-db-groupcount', String(group.rows.length)));
        table.append(header);
        paginate(table, group.rows, pageKey('table', group.key), tableRow);
        table.append(
          btn('nbe-db-newrow', '＋ Nouveau', () =>
            host.addRow(collectionId, groupProperties(group)),
          ),
        );
      }
    } else {
      paginate(table, rows, pageKey('table'), tableRow);
      table.append(btn('nbe-db-newrow', '＋ Nouveau', () => host.addRow(collectionId)));
    }
    return table;
  };

  /** Values a new row must carry to belong to the group it was created in. */
  const groupProperties = (group: RowGroup): Record<string, unknown> | undefined => {
    if (!cfg.groupBy || group.key === '' || cfg.groupBy === 'title') return undefined;
    const prop = schema.properties.find((p) => p.id === cfg.groupBy);
    if (!prop) return undefined;
    const value =
      prop.type === 'multi_select' ? [group.key] : prop.type === 'checkbox' ? group.key === 'true' : group.key;
    return { [prop.id]: value };
  };

  // ------------------------------------------------------------------ board
  const renderBoard = (): HTMLElement => {
    const board = el('div', 'nbe-db-board');
    if (!groups) {
      board.append(el('div', 'nbe-db-missing', 'Choisis une propriété de groupement pour le board.'));
      return board;
    }
    for (const group of groups) {
      const col = el('div', 'nbe-db-col');
      col.dataset['groupKey'] = group.key;
      const header = el('div', 'nbe-db-colhead');
      header.append(el('span', 'nbe-db-grouplabel', group.label), el('span', 'nbe-db-groupcount', String(group.rows.length)));
      col.append(header);
      const body = el('div', 'nbe-db-colbody');
      for (const row of group.rows) body.append(rowCard(row, { drag: true }));
      col.append(body);
      col.append(btn('nbe-db-newrow', '＋ Nouveau', () => host.addRow(collectionId, groupProperties(group))));
      board.append(col);
    }
    return board;
  };

  /**
   * The card both the board and the gallery are made of. `cover` adds the
   * gallery's image strip: there is no file property type, so the cover is the
   * first url property that points at an image — no extra config to set up,
   * and a collection without one simply gets text cards.
   */
  const rowCard = (row: RowData, opts: { drag?: boolean; cover?: boolean } = {}): HTMLElement => {
    const card = el('div', 'nbe-db-card');
    card.dataset['pageId'] = row.pageId;
    if (opts.cover) {
      const src = columns
        .filter((p) => p.type === 'url')
        .map((p) => String(row.properties[p.id] ?? ''))
        .find((v) => IMAGE_URL.test(v));
      const cover = el('div', 'nbe-db-cardcover');
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        cover.append(img);
      } else cover.classList.add('nbe-db-cardcover-empty');
      cover.addEventListener('click', () => host.openRow(row.pageId));
      card.append(cover);
    }
    const cardTitle = el('div', 'nbe-db-cardtitle', row.title || 'Sans titre');
    cardTitle.addEventListener('click', () => host.openRow(row.pageId));
    card.append(cardTitle);
    for (const prop of columns) {
      if (prop.id === cfg.groupBy) continue; // redundant inside its own column
      const value = row.properties[prop.id];
      const text = formatValue(value, prop.type);
      if (!text) continue;
      const line = el('div', 'nbe-db-cardprop');
      line.append(el('span', 'nbe-db-cardpropname', prop.name), el('span', 'nbe-db-cardpropvalue', text));
      card.append(line);
    }
    if (opts.drag) attachCardDrag(card, row);
    return card;
  };

  /** Dragging a card to another column writes the group property (Notion). */
  const attachCardDrag = (card: HTMLElement, row: RowData): void => {
    if (!cfg.groupBy || cfg.groupBy === 'title') return;
    const prop = schema.properties.find((p) => p.id === cfg.groupBy);
    if (!prop) return;
    let targetKey: string | null = null;
    let ghost: DragGhost | null = null;
    const cleanup = () => {
      card.classList.remove('nbe-db-dragging');
      document.body.classList.remove('nbe-drag-active');
      ghost?.destroy();
      ghost = null;
      for (const c of root.querySelectorAll('.nbe-db-col')) c.classList.remove('nbe-db-coltarget');
    };
    draggable(card, {
      onStart: (e) => {
        card.classList.add('nbe-db-dragging');
        document.body.classList.add('nbe-drag-active');
        ghost = createDragGhost([card], { count: 1 });
        ghost.move(e.clientX, e.clientY);
      },
      onMove: (e) => {
        ghost?.move(e.clientX, e.clientY);
        const col = (document.elementsFromPoint(e.clientX, e.clientY).find((n) =>
          (n as HTMLElement).classList?.contains('nbe-db-col'),
        ) ?? null) as HTMLElement | null;
        for (const c of root.querySelectorAll('.nbe-db-col')) c.classList.remove('nbe-db-coltarget');
        targetKey = col?.dataset['groupKey'] ?? null;
        if (col && targetKey !== null) col.classList.add('nbe-db-coltarget');
      },
      onDrop: () => {
        cleanup();
        if (targetKey === null) return;
        const value =
          prop.type === 'multi_select'
            ? targetKey === ''
              ? []
              : [targetKey]
            : prop.type === 'checkbox'
              ? targetKey === 'true'
              : targetKey;
        host.updateCell(collectionId, row.pageId, prop.id, value);
      },
      onCancel: cleanup,
    });
  };

  // ------------------------------------------------------------------- list
  const renderList = (): HTMLElement => {
    const list = el('div', 'nbe-db-list');
    const listItem = (row: RowData): HTMLElement => {
      const item = el('div', 'nbe-db-listitem');
      const label = el('span', 'nbe-db-listtitle');
      label.append('📄 ', row.title || 'Sans titre');
      label.addEventListener('click', () => host.openRow(row.pageId));
      item.append(label);
      for (const prop of columns) {
        const text = formatValue(row.properties[prop.id], prop.type);
        if (text) item.append(el('span', 'nbe-db-listprop', text));
      }
      return item;
    };
    if (groups) {
      for (const group of groups) {
        const header = el('div', 'nbe-db-groupheader');
        header.append(el('span', 'nbe-db-grouplabel', group.label), el('span', 'nbe-db-groupcount', String(group.rows.length)));
        list.append(header);
        paginate(list, group.rows, pageKey('list', group.key), listItem);
      }
    } else {
      paginate(list, rows, pageKey('list'), listItem);
    }
    list.append(btn('nbe-db-newrow', '＋ Nouveau', () => host.addRow(collectionId)));
    return list;
  };

  // ---------------------------------------------------------------- gallery
  const renderGallery = (): HTMLElement => {
    const wrap = el('div', 'nbe-db-gallery-wrap');
    const grid = () => el('div', 'nbe-db-gallery');
    const card = (row: RowData) => rowCard(row, { cover: true });
    if (groups) {
      // grouped gallery: one grid per group, stacked, like the list layout
      for (const group of groups) {
        const header = el('div', 'nbe-db-groupheader');
        header.append(
          el('span', 'nbe-db-grouplabel', group.label),
          el('span', 'nbe-db-groupcount', String(group.rows.length)),
        );
        wrap.append(header);
        const g = grid();
        wrap.append(g);
        paginate(g, group.rows, pageKey('gallery', group.key), card);
      }
    } else {
      const g = grid();
      wrap.append(g);
      paginate(g, rows, pageKey('gallery'), card);
    }
    wrap.append(btn('nbe-db-newrow', '＋ Nouveau', () => host.addRow(collectionId)));
    return wrap;
  };

  const LAYOUT_RENDERERS = {
    board: renderBoard,
    list: renderList,
    gallery: renderGallery,
    table: renderTable,
  };
  root.append((LAYOUT_RENDERERS[cfg.layout] ?? renderTable)());
  if (data.rows.length && !rows.length) {
    root.append(el('div', 'nbe-db-empty', 'Aucune ligne ne correspond aux filtres.'));
  }
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
