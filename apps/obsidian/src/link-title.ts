/**
 * What a page calls itself, for the editor's rename-a-link field.
 *
 * @remarks
 * This is why `onResolveLink` is a host hook rather than something the editor
 * does: a browser cannot read a page on another origin at all — `fetch` is
 * refused by CORS, and no amount of code in `@nbe/dom` changes that. A vault
 * has `requestUrl`, which goes through Electron's main process and is not
 * subject to it, so the vault is the one that can answer.
 *
 * No `obsidian` import here on purpose: that package is types-only outside the
 * app, so anything importing it cannot be unit-tested. The fetch lives beside
 * the other host hooks in `view.ts`; the parsing — the half with the edge
 * cases — lives here.
 *
 * @module
 */

/** The entities a `<title>` actually contains, decoded. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A title is one line: nothing that came from a pretty-printed `<title>` survives. */
const MAX = 120;

/**
 * Read a page's title out of its markup.
 *
 * @remarks
 * A regex rather than `DOMParser`, and not for speed: parsing a document
 * fetched from an arbitrary site builds a tree from somebody else's markup
 * inside the vault's own document, which is a larger surface than reading two
 * tags. `og:title` first, because it is the one the site chose for being
 * quoted elsewhere, which is exactly the use here.
 */
export function titleFromHtml(html: string): string | null {
  const head = html.slice(0, 100_000); // a title is at the top or it is nowhere
  const og = /<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]*>/i.exec(head)?.[0];
  const raw =
    (og && /content\s*=\s*["']([^"']*)["']/i.exec(og)?.[1]) ||
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  if (!raw) return null;
  const title = decode(raw).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.length > MAX ? `${title.slice(0, MAX - 1).trimEnd()}…` : title;
}
