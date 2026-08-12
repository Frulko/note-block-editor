import { debounce, type App } from 'obsidian';
import type CarnetPlugin from './main';

/**
 * The note's icon: one frontmatter key, drawn in two places.
 *
 * @remarks
 * `icon:` in the header of the note, which is where Obsidian's own ecosystem
 * already looks for one (Iconize writes the same key), so the choice travels
 * with the file and outlives this plugin. An emoji or an image — a vault path
 * or a URL — because the picker offers both and refusing the second half in
 * the sidebar would make the two views disagree about the same note.
 *
 * @module
 */

/** Vault paths the icon should render as a picture rather than as text. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/** Whether an icon value names a picture, as opposed to being one (an emoji). */
export function isImageSrc(value: string): boolean {
  return /^(https?|data|app|file):/i.test(value) || IMAGE_EXT.test(value);
}

/**
 * A stored path, as the vault spells it.
 *
 * @remarks
 * `decodeURI` and not a bare one: a picture called « 100%.png » is a legal
 * file and an illegal escape, and the raw call *throws* on it — which would
 * take the whole header down with it, over a percent sign in a filename.
 */
export function decodePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * An icon or cover value as something an `<img>` can load.
 *
 * @remarks
 * The same journey as {@link CarnetView.resolveAttachment} and for the same
 * reason: a vault path is not a URL a browser can fetch, and only the vault
 * can turn it into one. Sync, unlike its cousin, because nothing here is ever
 * a PDF.
 */
export function iconSrc(app: App, value: string, sourcePath = ''): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const file = app.metadataCache.getFirstLinkpathDest(decodePath(value), sourcePath);
  return file ? app.vault.getResourcePath(file) : value;
}

/** The icon as a node: an emoji is text, a path or a URL is a picture. */
export function iconEl(app: App, value: string, cls: string, sourcePath = ''): HTMLElement {
  if (!isImageSrc(value)) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = value;
    return span;
  }
  const img = document.createElement('img');
  img.className = cls;
  img.src = iconSrc(app, value, sourcePath);
  img.alt = '';
  return img;
}

/** The `icon:` a note carries, read from the cache rather than from the disk. */
export function noteIcon(app: App, path: string): string {
  const icon = app.metadataCache.getCache(path)?.frontmatter?.['icon'];
  return typeof icon === 'string' ? icon.trim() : '';
}

/**
 * Draw those icons in the file explorer, beside the note's name.
 *
 * @remarks
 * Obsidian has no API for this — the explorer is its own view and offers no
 * seam — so the icons are painted onto its DOM and repainted whenever it might
 * have changed underneath us. The list is virtualised: rows are recycled as
 * you scroll, so an icon put on a row can end up beside another note's name if
 * nothing watches. Hence the observer, which is what makes this survive a
 * scroll; the vault events are for the rest (a header edited, a note renamed,
 * a pane opened).
 *
 * Repainting is idempotent — a row already carrying its own icon is left
 * exactly as it is — which is also what stops the observer from feeding
 * itself: our own writes produce no *further* change, so the loop settles
 * after one pass.
 *
 * ponytail: a whole-explorer sweep per event, debounced. A vault with
 * thousands of visible rows would want a diff of the mutation records; a
 * `querySelectorAll` over what is on screen is nothing at the sizes a file
 * tree actually shows.
 */
export function paintExplorerIcons(plugin: CarnetPlugin): void {
  const app = plugin.app;
  const paint = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>('.nav-file-title[data-path]')) {
      const path = el.dataset['path'] ?? '';
      const icon = path.endsWith('.md') ? noteIcon(app, path) : '';
      const drawn = el.querySelector<HTMLElement>(':scope > .carnet-nav-icon');
      if (drawn?.dataset['icon'] === icon) continue;
      drawn?.remove();
      if (!icon) continue;
      const node = iconEl(app, icon, 'carnet-nav-icon', path);
      node.dataset['icon'] = icon;
      el.prepend(node);
    }
  };
  // leading edge: an icon chosen a moment ago should appear now, not in 50ms
  const schedule = debounce(paint, 50, true);
  plugin.registerEvent(app.metadataCache.on('changed', schedule));
  plugin.registerEvent(app.vault.on('rename', schedule));
  plugin.registerEvent(app.vault.on('delete', schedule));
  plugin.registerEvent(app.workspace.on('layout-change', schedule));

  const observer = new MutationObserver(schedule);
  plugin.register(() => observer.disconnect());
  // and the icons come off with the plugin: a stale emoji beside a filename
  // would outlive the thing that put it there
  plugin.register(() => document.querySelectorAll('.carnet-nav-icon').forEach((el) => el.remove()));
  app.workspace.onLayoutReady(() => {
    for (const container of document.querySelectorAll('.nav-files-container'))
      observer.observe(container, { childList: true, subtree: true });
    paint();
  });
}
