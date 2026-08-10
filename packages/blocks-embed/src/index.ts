/**
 * The embed: one block type, and a table of providers.
 *
 * @remarks
 * Notion ships nineteen entries for this — YouTube, Vimeo, Figma, Loom, PDF,
 * Web bookmark, HTML… — and underneath they are the same block. The entries
 * exist for discoverability, which is a real need, so the slash menu has
 * several of them here too; the *model* is one type, `{ src, provider, mode,
 * height }`, and one table. Adding a provider is a line, not a package.
 *
 * Two of the nineteen genuinely want something other than an `<iframe>`, and
 * that is the measure of the design:
 *
 * - **HTML** has no URL at all: the markup is in the block, and it goes in
 *   `srcdoc`. Same sandbox as a dropped `.html` file, for the same reasons.
 * - **A Gist** is a `<script>`, and GitHub refuses to be framed — so it falls
 *   back to a card rather than to a blank box.
 *   ponytail: fetching the gist's raw text at insert time and making a `code`
 *   block is the better answer and needs a network call; do it when someone
 *   asks for gists specifically.
 *
 * Markdown is `[titre](url)` plus a `<!-- nbe:embed … -->` trailer, which is
 * the mechanism `markdownAmbiguous` already describes: the line stays a link
 * every other tool renders, and the trailer is what says it was an embed.
 *
 * The editing behaviour lives in `@nbe/blocks-embed/dom`.
 *
 * @module @nbe/blocks-embed
 */
import type { Block, BlockPlugin, MarkdownProjection } from '@nbe/core';
import { PLUGIN_API_VERSION } from '@nbe/core';

/**
 * How an embed is shown.
 *
 * @remarks
 * `iframe` is the provider's own player. `card` is a link with its host's
 * name — what Notion calls a web bookmark, and the honest answer for anything
 * that refuses to be framed. `srcdoc` is markup held in the block itself.
 *
 * @category Plugins
 */
export type EmbedMode = 'iframe' | 'card' | 'srcdoc';

/** One line of the table. `frame` returns the URL to put in the `<iframe>`. */
export interface EmbedProvider {
  id: string;
  label: string;
  match: RegExp;
  frame?: (url: URL) => string | null;
  /** Width ÷ height, when the provider has one worth keeping. */
  ratio?: number;
  /** Providers that cannot be framed at all fall back to this. */
  mode?: EmbedMode;
}

/** The last path segment, which is the id for most of these. */
const lastSegment = (url: URL): string => url.pathname.split('/').filter(Boolean).pop() ?? '';

/**
 * The table. One line per provider, not one plugin per provider.
 *
 * @remarks
 * Order is precedence: the first `match` wins, and `pdf` is last of the
 * specific ones because a PDF served *from* one of the others is still that
 * provider's page.
 *
 * @category Plugins
 */
export const PROVIDERS: readonly EmbedProvider[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    match: /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/,
    ratio: 16 / 9,
    frame: (url) => {
      // four spellings of the same id: youtu.be/ID, /watch?v=ID, /shorts/ID,
      // and /embed/ID for a URL somebody already copied out of an embed
      const id = url.hostname.endsWith('youtu.be')
        ? lastSegment(url)
        : (url.searchParams.get('v') ?? lastSegment(url));
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
    },
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    match: /(?:^|\.)vimeo\.com$/,
    ratio: 16 / 9,
    frame: (url) => {
      const id = lastSegment(url);
      return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    },
  },
  {
    id: 'loom',
    label: 'Loom',
    match: /(?:^|\.)loom\.com$/,
    ratio: 16 / 9,
    frame: (url) => {
      const id = lastSegment(url);
      return id ? `https://www.loom.com/embed/${encodeURIComponent(id)}` : null;
    },
  },
  {
    id: 'dailymotion',
    label: 'Dailymotion',
    match: /(?:^|\.)(?:dailymotion\.com|dai\.ly)$/,
    ratio: 16 / 9,
    frame: (url) => {
      const id = lastSegment(url);
      return id ? `https://www.dailymotion.com/embed/video/${encodeURIComponent(id)}` : null;
    },
  },
  {
    id: 'spotify',
    label: 'Spotify',
    match: /(?:^|\.)spotify\.com$/,
    frame: (url) => {
      // /track/ID, /album/ID, /playlist/ID, /episode/ID — the kind is part of
      // the embed path, so it is taken from the URL rather than guessed
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts.pop();
      const kind = parts.pop();
      return kind && id ? `https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}` : null;
    },
  },
  {
    id: 'figma',
    label: 'Figma',
    match: /(?:^|\.)figma\.com$/,
    frame: (url) => `https://www.figma.com/embed?embed_host=carnet&url=${encodeURIComponent(url.href)}`,
  },
  {
    id: 'codepen',
    label: 'CodePen',
    match: /(?:^|\.)codepen\.io$/,
    frame: (url) => url.href.replace('/pen/', '/embed/'),
  },
  {
    id: 'codesandbox',
    label: 'CodeSandbox',
    match: /(?:^|\.)codesandbox\.io$/,
    frame: (url) => url.href.replace('/s/', '/embed/'),
  },
  {
    // a `<script>` tag, and GitHub sends X-Frame-Options: an iframe here is a
    // blank box, which is worse than a link that says where it goes
    id: 'gist',
    label: 'GitHub Gist',
    match: /(?:^|\.)gist\.github\.com$/,
    mode: 'card',
  },
  {
    id: 'pdf',
    label: 'PDF',
    match: /\.pdf(?:[?#]|$)/,
    frame: (url) => url.href,
  },
];

/** The provider a URL belongs to, or `null` for anything unrecognised. */
export function providerFor(src: string): EmbedProvider | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  for (const provider of PROVIDERS) {
    // the PDF line matches a path, every other line matches a host
    if (provider.id === 'pdf' ? provider.match.test(url.pathname) : provider.match.test(url.hostname)) {
      return provider;
    }
  }
  return null;
}

/**
 * The URL to put in the `<iframe>`, or `null` when there is nothing to frame.
 *
 * @remarks
 * `null` is a real answer and the caller has to handle it: a YouTube link with
 * no video id in it, a Spotify URL that is the home page. Framing the original
 * URL there gives a page that refuses to be framed, so the block shows a card.
 */
export function frameUrl(src: string): string | null {
  const provider = providerFor(src);
  if (provider?.mode === 'card') return null;
  if (!provider) return /^https?:/i.test(src) ? src : null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  return provider.frame ? provider.frame(url) : url.href;
}

/** The block's mode: what it was told, else what its provider allows. */
export function embedMode(props: Record<string, unknown> | undefined): EmbedMode {
  const value = props?.['mode'];
  if (value === 'iframe' || value === 'card' || value === 'srcdoc') return value;
  const src = String(props?.['src'] ?? '');
  if (!src) return props?.['html'] ? 'srcdoc' : 'iframe';
  return frameUrl(src) ? 'iframe' : 'card';
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * `[titre](url)` **with** the marker still on it.
 *
 * @remarks
 * The rule is matched against the line as it is in the file, not against the
 * line with its trailer stripped, because the trailer is the only thing that
 * says this link was a block. What the rule then takes off the line is the
 * pair `spelledProps` declares; the parser puts the rest back from the marker.
 */
const LINE = /^\s*\[([^\]]*)\]\(([^)]*)\)\s*<!--\s*nbe:embed(\s*\{.*?\})?\s*-->\s*$/;

/**
 * `[titre](url)` plus the marker that says the line was an embed.
 *
 * @remarks
 * Without the marker the line is prose — any rule broad enough to claim a lone
 * link would claim every paragraph that happens to be one, which is exactly
 * what `markdownAmbiguous` exists to say. So the marker is always written,
 * even with nothing else to carry: it *is* the type.
 *
 * @category Projections
 */
export const embedMarkdown: MarkdownProjection = {
  toMarkdown(block, ctx) {
    const pad = '    '.repeat(ctx.depth);
    const props = block.props ?? {};
    const src = String(props['src'] ?? '');
    const title = String(props['title'] ?? '') || providerFor(src)?.label || 'intégration';
    /*
     * The line only. The trailer is not written here: `spelledProps` names
     * `src` and `title` as the two the line already spells, and the serialiser
     * appends everything else — plus the bare marker `markdownAmbiguous` asks
     * for. Writing it by hand as well produced two of them on every save, and
     * the second one grew a copy of the props each time.
     */
    return [`${pad}[${title}](${src})`];
  },
  fromMarkdown: [
    {
      match: LINE,
      parse(lines, start) {
        const m = LINE.exec(lines[start] ?? '');
        if (!m) return null;
        let props: Record<string, unknown> = {};
        try {
          const parsed = m[3]?.trim() ? (JSON.parse(m[3]) as { props?: Record<string, unknown> }) : {};
          props = parsed.props ?? {};
        } catch {
          /* a hand-edited trailer costs the props, never the block */
        }
        return {
          block: {
            id: '',
            type: 'embed',
            version: 1,
            props: { ...props, src: m[2] ?? '', title: m[1] ?? '' },
            text: [],
            children: [],
            parentId: null,
          },
          consumed: 1,
        };
      },
    },
  ],
};

/**
 * The embed, minus its editing behaviour.
 *
 * @category Plugins
 */
export const embedPlugin: BlockPlugin = {
  apiVersion: PLUGIN_API_VERSION,
  schema: {
    type: 'embed',
    version: 1,
    inline: false,
    // the line is a link, and a link says nothing about being a block
    markdownAmbiguous: true,
    spelledProps: ['src', 'title'],
    defaultProps: {},
    placeholder: 'Collez un lien à intégrer',
  },
  markdown: embedMarkdown,
  html(block) {
    const props = block.props ?? {};
    const src = String(props['src'] ?? '');
    const mode = embedMode(props);
    const height = Number(props['height'] ?? 0) || 400;
    if (mode === 'card' || !src) {
      const title = String(props['title'] ?? '') || src;
      return `<p id="${escapeHtml(block.id)}" class="nbe-t-embed" data-embed-mode="card"><a href="${escapeHtml(src)}">${escapeHtml(title)}</a></p>`;
    }
    if (mode === 'srcdoc') {
      const html = String(props['html'] ?? '');
      return `<iframe id="${escapeHtml(block.id)}" class="nbe-t-embed" data-embed-mode="srcdoc" sandbox="allow-scripts" height="${height}" srcdoc="${escapeHtml(html)}"></iframe>`;
    }
    const url = frameUrl(src) ?? src;
    return `<iframe id="${escapeHtml(block.id)}" class="nbe-t-embed" data-embed-mode="iframe" height="${height}" src="${escapeHtml(url)}" loading="lazy" allowfullscreen></iframe>`;
  },
};

/**
 * The plugin, as the array a headless host registers.
 *
 * @category Plugins
 */
export const embedBlocks: BlockPlugin[] = [embedPlugin];
