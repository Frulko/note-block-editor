/**
 * The drop zone: one block that collects the files you give it.
 *
 * @remarks
 * A `file` block is one file. This is the other shape the same need takes — a
 * place on the page where things accumulate: the PDFs for a chapter, the
 * screenshots for a bug, the clips for an edit. It is **one block holding a
 * list**, not a container holding `file` blocks, and that is a Markdown
 * decision rather than a modelling one: a container's boundaries have nowhere
 * to live in Markdown, while a list of links is something Markdown already
 * spells — and spells in a way every other tool renders.
 *
 * So a zone is written as an ordinary bulleted list of links between two
 * comment markers. Open the note anywhere else and you see the files, with
 * working links. Open it here and you get the zone back, because the markers
 * are what says these particular links were a zone.
 *
 * `accept` is the one thing it can refuse: `all`, `image`, `video` or `pdf`.
 * The editing behaviour lives in `@nbe/blocks-dropzone/dom`.
 *
 * @module @nbe/blocks-dropzone
 */
import type { Block, BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION } from '@nbe/core';

/** One collected file. `src` is whatever the host's asset store handed back. */
export interface DroppedFile {
  name: string;
  src: string;
  /** Bytes, when the host knew. */
  size?: number;
  mime?: string;
}

/**
 * What a zone will take.
 *
 * @remarks
 * Coarse on purpose. A zone that filters on exact MIME types is a zone that
 * silently refuses a `.mov` because it arrived as `video/quicktime`, and the
 * person dropping it has no way to see why.
 *
 * @category Plugins
 */
export const DROP_KINDS = [
  { name: 'all', label: 'Tout fichier', accept: '*/*', icon: 'plus' },
  { name: 'image', label: 'Images', accept: 'image/*', icon: 'image' },
  { name: 'video', label: 'Vidéos', accept: 'video/*', icon: 'workflow' },
  { name: 'pdf', label: 'PDF', accept: 'application/pdf,.pdf', icon: 'file-text' },
] as const;

/** One of {@link DROP_KINDS}' names. */
export type DropKind = (typeof DROP_KINDS)[number]['name'];

/** The zone's kind, falling back to `all` for anything unknown. */
export function dropKind(props: Record<string, unknown> | undefined): DropKind {
  const value = props?.['kind'];
  return DROP_KINDS.some((k) => k.name === value) ? (value as DropKind) : 'all';
}

/** The files a zone holds, defensively — props come from a file on disk. */
export function dropFiles(props: Record<string, unknown> | undefined): DroppedFile[] {
  const value = props?.['files'];
  if (!Array.isArray(value)) return [];
  return value
    .filter((f): f is DroppedFile => !!f && typeof f === 'object' && typeof (f as DroppedFile).src === 'string')
    .map((f) => ({ name: String(f.name ?? f.src), src: f.src, size: f.size, mime: f.mime }));
}

/**
 * Whether a zone of this kind will take a file.
 *
 * @remarks
 * The name is consulted as well as the MIME type, because a browser reports
 * no type at all for plenty of ordinary files — measured on `.mkv` and on
 * anything arriving from a network share.
 */
export function accepts(kind: DropKind, file: { type?: string; name?: string }): boolean {
  if (kind === 'all') return true;
  const type = (file.type ?? '').toLowerCase();
  const name = (file.name ?? '').toLowerCase();
  if (kind === 'pdf') return type === 'application/pdf' || name.endsWith('.pdf');
  return type.startsWith(`${kind}/`) || (!type && new RegExp(EXTENSIONS[kind]).test(name));
}

/** The fallback for a file the browser typed as nothing at all. */
const EXTENSIONS: Record<'image' | 'video', string> = {
  image: '\\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$',
  video: '\\.(mp4|webm|mov|mkv|avi|m4v)$',
};

const OPEN = /^<!--\s*nbe:drop_zone\s*(\{.*\})?\s*-->\s*$/;
const CLOSE = /^<!--\s*\/nbe:drop_zone\s*-->\s*$/;
/** `- [name](src)`, with the `file` block's own trailer when there is one. */
const ITEM = /^\s*-\s+\[([^\]]*)\]\(([^)]*)\)\s*(?:<!--\s*nbe:file\s*(\{.*?\})\s*-->)?\s*$/;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** `--` inside the payload would close the comment early. */
const payload = (value: unknown): string => JSON.stringify(value).replace(/--/g, '\\u002d\\u002d');

/**
 * A bulleted list of links, between two markers.
 *
 * @category Projections
 */
export const dropZoneMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const kind = dropKind(block.props);
    const head = kind === 'all' ? '{}' : payload({ kind });
    const lines = [`${pad}<!-- nbe:drop_zone ${head} -->`];
    for (const file of dropFiles(block.props)) {
      // the trailer is the `file` block's, spelled the same way, because it
      // carries the same two facts and one spelling is one thing to get right
      const extra: Record<string, unknown> = {};
      if (file.size !== undefined) extra['size'] = file.size;
      if (file.mime) extra['mime'] = file.mime;
      const trailer = Object.keys(extra).length ? ` <!-- nbe:file ${payload({ props: extra })} -->` : '';
      lines.push(`${pad}- [${file.name}](${file.src})${trailer}`);
    }
    lines.push(`${pad}<!-- /nbe:drop_zone -->`);
    return lines;
  },
  fromMarkdown: [
    {
      match: OPEN,
      parse(lines, start) {
        const head = OPEN.exec(lines[start] ?? '');
        if (!head) return null;
        let props: Record<string, unknown> = {};
        try {
          props = head[1] ? JSON.parse(head[1]) : {};
        } catch {
          /* a hand-edited marker: the zone is still a zone, it is just `all` */
        }
        const files: DroppedFile[] = [];
        let at = start + 1;
        for (; at < lines.length && !CLOSE.test(lines[at] ?? ''); at++) {
          const item = ITEM.exec(lines[at] ?? '');
          if (!item) continue; // a blank line, or something hand-written: skip it
          const file: DroppedFile = { name: item[1] ?? '', src: item[2] ?? '' };
          if (item[3]) {
            try {
              const extra = JSON.parse(item[3]) as { props?: { size?: number; mime?: string } };
              if (typeof extra.props?.size === 'number') file.size = extra.props.size;
              if (extra.props?.mime) file.mime = extra.props.mime;
            } catch {
              /* same: the link is the fact, the trailer is the decoration */
            }
          }
          files.push(file);
        }
        // an unclosed zone eats the rest of the note otherwise, which is how a
        // truncated file turns one bad line into a lost document
        if (at >= lines.length) return null;
        return {
          block: {
            id: '',
            type: 'drop_zone',
            version: 1,
            props: { kind: dropKind(props), files },
            text: [],
            children: [],
            parentId: null,
          },
          consumed: at - start + 1,
        };
      },
    },
  ],
};

/**
 * The drop zone, minus its editing behaviour.
 *
 * @category Plugins
 */
export const dropZonePlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'drop_zone',
    version: 1,
    inline: false,
    defaultProps: { kind: 'all', files: [] },
    placeholder: 'Déposez des fichiers ici',
  },
  markdown: dropZoneMarkdown,
  html(block) {
    const items = dropFiles(block.props)
      .map((f) => `<li><a href="${escapeHtml(f.src)}">${escapeHtml(f.name)}</a></li>`)
      .join('');
    return `<ul class="nbe-t-drop_zone" data-drop-kind="${dropKind(block.props)}">${items}</ul>`;
  },
};

/**
 * The plugin, as the array a headless host registers.
 *
 * @category Plugins
 */
export const dropZoneBlocks: BlockPlugin[] = [dropZonePlugin];
