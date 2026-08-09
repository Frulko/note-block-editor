/**
 * The drop zone's editing behaviour: the box you drop on, the list it keeps,
 * and the one choice it offers — what it will take.
 *
 * @module @nbe/blocks-dropzone/dom
 */
import type { Block } from '@nbe/core';
import { fileToDataUrl, icon, type DomBlockPlugin, type EditorView } from '@nbe/dom';
import { accepts, dropFiles, dropKind, DROP_KINDS, dropZonePlugin, type DroppedFile, type DropKind } from './index';

/** Bytes, as a file manager shows them. Base 10, like the `file` block's. */
function formatBytes(n: number): string {
  if (n < 1000) return `${n} o`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(0)} Ko`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1e6).toFixed(1)} Mo`;
  return `${(n / 1e9).toFixed(1)} Go`;
}

/**
 * Store a batch and append it, in one transaction.
 *
 * @remarks
 * One transaction for the whole batch, not one per file: `props.files` is
 * replaced wholesale, so a per-file dispatch would have each one overwrite the
 * list the previous had just written. Dropping five files would keep the last.
 */
async function add(view: EditorView, block: Block, incoming: readonly File[]): Promise<void> {
  const kind = dropKind(block.props);
  const wanted = incoming.filter((f) => accepts(kind, f));
  if (!wanted.length) return;
  const store = view.options.onStoreAsset;
  const added: DroppedFile[] = await Promise.all(
    wanted.map(async (file) => ({
      name: file.name,
      src: store ? await store(file) : await fileToDataUrl(file),
      size: file.size,
      mime: file.type,
    })),
  );
  // re-read: storing is asynchronous, and the block may have taken another
  // drop while these bytes were being written
  const current = view.editor.doc.blocks.get(block.id);
  if (!current) return;
  view.editor.dispatch(
    (tx) =>
      tx.op({
        type: 'update_block',
        id: block.id,
        patch: { props: { files: [...dropFiles(current.props), ...added] } },
      }),
    { origin: 'ui' },
  );
}

function remove(view: EditorView, block: Block, at: number): void {
  const files = dropFiles(view.editor.doc.blocks.get(block.id)?.props);
  view.editor.dispatch(
    (tx) =>
      tx.op({
        type: 'update_block',
        id: block.id,
        patch: { props: { files: files.filter((_, i) => i !== at) } },
      }),
    { origin: 'ui' },
  );
}

/** The file picker, `multiple` — a zone that takes one file at a time is a `file` block. */
function pick(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.click();
  });
}

/**
 * The drop zone, ready to mount.
 *
 * @example
 * ```ts
 * import { dropZone } from '@nbe/blocks-dropzone/dom'
 * new EditorView(el, editor, { blocks: [...builtinBlocks, dropZone] })
 * ```
 *
 * @category Plugins
 */
export const dropZone: DomBlockPlugin = {
  ...dropZonePlugin,
  view: {
    render(ctx, block) {
      const view = ctx.view;
      const kind = dropKind(block.props);
      const preset = DROP_KINDS.find((k) => k.name === kind)!;
      const files = dropFiles(block.props);
      // no caret goes in here: the list is the content, and it is not text
      ctx.root.setAttribute('contenteditable', 'false');
      ctx.root.dataset['dropKind'] = kind;

      const list = document.createElement('ul');
      list.className = 'nbe-dropzone-list';
      files.forEach((file, at) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'nbe-dropzone-file';
        link.download = file.name;
        link.append(icon(preset.icon, { size: 15 }));
        const label = document.createElement('span');
        label.textContent = file.name;
        link.append(label);
        if (file.size) {
          const size = document.createElement('span');
          size.className = 'nbe-dropzone-size';
          size.textContent = formatBytes(file.size);
          link.append(size);
        }
        const href = view.options.resolveAssetUrl?.(file.src) ?? file.src;
        if (typeof href === 'string') link.href = href;
        else void href.then((url) => (link.href = url));

        const bin = document.createElement('button');
        bin.type = 'button';
        bin.className = 'nbe-dropzone-remove';
        bin.title = 'Retirer';
        bin.setAttribute('aria-label', `Retirer ${file.name}`);
        bin.dataset['nbeUi'] = '';
        bin.append(icon('x', { size: 13 }));
        bin.addEventListener('click', () => remove(view, block, at));

        item.append(link, bin);
        list.append(item);
      });
      if (files.length) ctx.root.append(list);

      const zone = document.createElement('div');
      zone.className = 'nbe-dropzone-target';
      zone.dataset['nbeUi'] = '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nbe-dropzone-add';
      button.append(icon(preset.icon, { size: 16 }));
      const caption = document.createElement('span');
      caption.textContent = files.length ? `Ajouter — ${preset.label.toLowerCase()}` : `Déposez ici — ${preset.label.toLowerCase()}`;
      button.append(caption);
      button.addEventListener('click', async () => void add(view, block, await pick(preset.accept)));
      zone.append(button);

      /*
       * The zone's own drop handler, ahead of the editor's. `stopPropagation`
       * is what keeps the editor from also turning the same drop into a `file`
       * block beside this one — the two handlers would otherwise both fire and
       * the file would be added twice, in two places.
       */
      const active = (on: boolean) => zone.classList.toggle('nbe-dropzone-active', on);
      zone.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        active(true);
      });
      zone.addEventListener('dragleave', () => active(false));
      zone.addEventListener('drop', (e) => {
        const dropped = [...(e.dataTransfer?.files ?? [])];
        if (!dropped.length) return;
        e.preventDefault();
        e.stopPropagation();
        active(false);
        void add(view, block, dropped);
      });
      ctx.root.append(zone);
      return ctx.root;
    },

    toolbar(ctx) {
      const current = dropKind(ctx.block.props);
      return DROP_KINDS.map((preset) => ({
        icon: preset.icon,
        title: preset.label,
        active: preset.name === current,
        // changing the kind never drops what is already there: a zone narrowed
        // to PDFs after the fact would otherwise silently delete the images
        onClick: () => ctx.setProps({ kind: preset.name as DropKind }),
      }));
    },
    toolbarPlacement: 'above',

    slash: DROP_KINDS.map((preset) => ({
      label: preset.name === 'all' ? 'Zone de dépôt' : `Zone de dépôt — ${preset.label.toLowerCase()}`,
      keywords: ['dépôt', 'depot', 'drop', 'fichiers', 'files', preset.name],
      icon: preset.icon,
      props: { kind: preset.name },
    })),

    styles: `
.nbe-t-drop_zone {
  padding: 4px 0;
}
.nbe-dropzone-list {
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nbe-dropzone-list li {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
}
.nbe-dropzone-file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--nbe-border);
  border-radius: var(--nbe-radius-sm, 4px);
  color: inherit;
  text-decoration: none;
}
.nbe-dropzone-file:hover { background: var(--nbe-hover); }
.nbe-dropzone-file span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nbe-dropzone-size {
  margin-left: auto;
  color: var(--nbe-text-light);
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
}
.nbe-dropzone-remove {
  display: inline-flex;
  align-items: center;
  padding: 5px;
  border: none;
  border-radius: var(--nbe-radius-sm, 4px);
  background: transparent;
  color: var(--nbe-text-faint);
  cursor: pointer;
}
.nbe-dropzone-remove:hover { background: var(--nbe-hover); color: var(--nbe-text); }
.nbe-dropzone-target {
  border: 1px dashed var(--nbe-border-strong);
  border-radius: var(--nbe-radius-sm, 4px);
  transition: background var(--nbe-fast) var(--nbe-ease), border-color var(--nbe-fast) var(--nbe-ease);
}
.nbe-dropzone-target.nbe-dropzone-active {
  border-color: var(--nbe-accent);
  background: rgb(var(--nbe-accent-rgb) / 0.08);
}
.nbe-dropzone-add {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--nbe-text-light);
  font: inherit;
  font-size: 0.92em;
  cursor: pointer;
}
.nbe-dropzone-add:hover { color: var(--nbe-text); }
`,
  },
};

export {
  accepts,
  dropFiles,
  dropKind,
  dropZoneMarkdown,
  dropZonePlugin,
  DROP_KINDS,
} from './index';
export type { DroppedFile, DropKind } from './index';
