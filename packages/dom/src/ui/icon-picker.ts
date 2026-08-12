import { autoUpdate, type AnchorRect } from './position';
import { mountPortal } from './portal';
import { pushOverlay } from './overlay';
import { createDropZone, fileToDataUrl } from './upload';
import { defaultLabels, type EditorLabels } from '../labels';

/**
 * Icon picker: emoji grid with search, plus a custom image tab (uploaded
 * files become a data URL, or an opaque asset ref when the host stores them).
 * Used by callouts today; any block wanting an icon reuses this.
 */

/**
 * An emoji and what it is called, one string per language.
 *
 * @remarks
 * Explicit tuples. Deliberately NOT a string of emojis aligned to a parallel
 * keyword array: ZWJ sequences and variation selectors make any positional
 * alignment silently drift.
 *
 * The tail is open because an entry may carry several languages at once —
 * `@nbe/emoji`'s `mergeCatalogues` builds exactly that — and {@link searchable}
 * reads all of them, so « fusée » and "rocket" reach the same emoji. A third
 * language is a third slot and no other change.
 *
 * Structurally the same type `@nbe/emoji` declares, restated rather than
 * imported: the editor has no runtime dependencies, and a catalogue is data
 * a host hands in, not a package the editor reaches for.
 */
export type EmojiEntry = readonly [emoji: string, ...names: string[]];

export interface EmojiGroup {
  label: string;
  items: readonly EmojiEntry[];
}

/*
 * A curated set — enough to be useful, small enough to need no dependency.
 * English, because that is what this editor ships in and every other language
 * is opt-in (`src/i18n`); a host that wants all 1914 emoji in its reader's
 * language passes one of `@nbe/emoji`'s catalogues as `emojis`.
 */
const GROUPS: EmojiGroup[] = [
  {
    label: 'Frequent',
    items: [
      ['💡', 'idea, light bulb, insight'],
      ['⚠️', 'warning, caution, danger'],
      ['✅', 'done, ok, check, valid'],
      ['❌', 'error, cross, no, failed'],
      ['📌', 'pin, pinned, marker'],
      ['🔥', 'fire, hot, urgent'],
      ['⭐️', 'star, favourite, favorite'],
      ['❤️', 'heart, love, like'],
      ['🎯', 'target, goal, aim'],
      ['🚀', 'rocket, launch, ship'],
      ['📝', 'note, memo, write'],
      ['🔔', 'bell, reminder, notification'],
    ],
  },
  {
    label: 'Objects',
    items: [
      ['📁', 'folder, directory'],
      ['📂', 'open folder, directory'],
      ['📄', 'document, page, file'],
      ['📅', 'calendar, date, schedule'],
      ['📊', 'chart, stats, report'],
      ['📈', 'up, growth, increase'],
      ['📉', 'down, decline, decrease'],
      ['🔍', 'search, find, magnifier'],
      ['🔑', 'key, access, secret'],
      ['🔒', 'lock, locked, private'],
      ['🔓', 'unlock, unlocked, public'],
      ['📎', 'paperclip, attachment'],
      ['✂️', 'scissors, cut'],
      ['🖊️', 'pen, write, edit'],
      ['📚', 'books, docs, library'],
      ['🗂️', 'files, archive, index'],
    ],
  },
  {
    label: 'Symbols',
    items: [
      ['✨', 'sparkles, magic, new'],
      ['🎉', 'party, celebration, release'],
      ['🏆', 'trophy, won, success'],
      ['🎨', 'palette, design, colour'],
      ['🧠', 'brain, thinking, idea'],
      ['⚙️', 'gear, settings, config'],
      ['🔧', 'wrench, fix, repair'],
      ['🧪', 'test, lab, experiment'],
      ['💾', 'save, disk, backup'],
      ['🌐', 'web, world, global'],
      ['🔗', 'link, url, chain'],
      ['♻️', 'recycle, refactor'],
      ['🚧', 'work in progress, wip, roadworks'],
      ['🛑', 'stop, blocked, halt'],
      ['ℹ️', 'info, information'],
      ['❓', 'question, help, unknown'],
    ],
  },
  {
    label: 'Nature',
    items: [
      ['🌱', 'seedling, plant, start'],
      ['🌳', 'tree, nature'],
      ['🍀', 'clover, luck'],
      ['🌊', 'wave, sea, flow'],
      ['💧', 'drop, water'],
      ['☀️', 'sun, day, light'],
      ['🌙', 'moon, night, dark'],
      ['❄️', 'snow, cold, frozen'],
      ['🐛', 'bug, insect, issue'],
      ['🦋', 'butterfly, transformation'],
      ['🐢', 'turtle, slow'],
      ['🐇', 'rabbit, fast, quick'],
    ],
  },
  {
    label: 'People',
    items: [
      ['👤', 'person, user, profile'],
      ['👥', 'group, team, people'],
      ['🙋', 'raised hand, question'],
      ['🧑‍💻', 'developer, coder, dev'],
      ['👏', 'clap, applause, bravo'],
      ['🤝', 'handshake, deal, agreement'],
      ['💬', 'comment, chat, bubble'],
      ['🗣️', 'speaking, discussion, voice'],
    ],
  },
];

/**
 * Fold for searching: NFC/NFD-insensitive and diacritic-insensitive, so a
 * query typed as "fusee" or with a decomposed é still matches "fusée"
 * (the normalization trap from AQ#4, here in its user-visible form).
 */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Everything an entry can be found by, folded — its names in every language it
 * carries, joined.
 *
 * @remarks
 * Cached on the tuple itself: the full catalogue is 1914 entries of some 80
 * characters each, and folding all of it on *every keystroke* is 150 kB of
 * `normalize()` per letter typed. Once per entry per session instead, and a
 * `WeakMap` means the cache dies with the catalogue rather than pinning it.
 */
const FOLDED = new WeakMap<object, { all: string; names: string }>();
function searchable(entry: EmojiEntry): { all: string; names: string } {
  const known = FOLDED.get(entry);
  if (known) return known;
  const text = {
    all: fold(entry.slice(1).join(' ')),
    // the name is the head of each language's list, before its keywords —
    // « visage rieur » out of « visage rieur, content, dents, grand sourire »
    names: fold(entry.slice(1).map((s) => s.split(',')[0]!).join(' ')),
  };
  FOLDED.set(entry, text);
  return text;
}

/**
 * How wide a window of `text` holds `query`'s letters in order — `-1` when it
 * does not hold them at all.
 *
 * @remarks
 * The typed-in-a-hurry match: « cnfti » finds « confettis », « fsee » finds
 * « fusée », « rockt » finds the same one from the other language.
 *
 * The *span* is what makes it usable rather than merely true. A subsequence on
 * its own is an extremely loose thing to ask of 1914 names: « cnfti » is
 * satisfied by « visage souriant ave**c** de gra**n**ds yeux » too, because
 * five letters in that order turn up in almost any sentence. Measuring how far
 * apart they landed separates a mistyped word from a coincidence — the caller
 * keeps the tight ones and shows them closest-first.
 *
 * Forwards for the earliest end, then backwards from it for the latest start:
 * two greedy passes, which give the tightest window around *that* end. Not the
 * global minimum over every end — that is a dynamic program, for a difference
 * nobody would see in a list of emoji.
 */
function fuzzySpan(text: string, query: string): number {
  let at = 0;
  for (const ch of query) {
    at = text.indexOf(ch, at) + 1;
    if (at === 0) return -1;
  }
  let start = at;
  for (let i = query.length - 1; i >= 0; i--) start = text.lastIndexOf(query[i]!, start - 1);
  return at - start;
}


export interface IconPickerOptions {
  current?: string;
  onPick: (icon: string) => void;
  onRemove?: () => void;
  /** Store an uploaded image and return the src to persist (asset ref or data URL). */
  storeImage?: (file: File) => Promise<string>;
  /**
   * The emoji to offer. Defaults to the curated set bundled with the editor.
   *
   * @remarks
   * This is the seam that keeps every emoji off the default path: `@nbe/dom`
   * ships a couple of dozen, and a host that wants all of them imports
   * `EMOJI_CATALOG` and hands it over — two hundred kilobytes of CLDR names
   * that an app which never opens this picker should not be carrying.
   */
  emojis?: readonly EmojiGroup[];
  /**
   * Drop the emoji tab: an image, uploaded or by URL, and nothing else.
   *
   * @remarks
   * For a picture where a picture is the whole point — a page cover — where
   * offering « 🚀 » would be offering something the caller cannot draw. One
   * tab is no tab, so the bar goes with it.
   */
  imageOnly?: boolean;
  /** What removing is called, when "Remove the icon" is the wrong noun. */
  removeLabel?: string;
  /**
   * The language the picker speaks. Defaults to the editor's own default,
   * which is English — a host passes `view.labels`.
   */
  labels?: EditorLabels;
}

export interface IconPickerController {
  close: () => void;
}

export function openIconPicker(
  getAnchor: () => AnchorRect | null,
  options: IconPickerOptions,
): IconPickerController {
  const root = document.createElement('div');
  root.className = 'nbe-menu nbe-iconpicker';
  root.dataset['nbeUi'] = '';
  const catalogue = options.emojis ?? GROUPS;
  const labels = options.labels ?? defaultLabels;

  let stopAuto: (() => void) | null = null;
  let stopDismiss: (() => void) | null = null;
  const close = () => {
    stopAuto?.();
    stopDismiss?.();
    root.remove();
  };

  // --- tabs
  const tabs = document.createElement('div');
  tabs.className = 'nbe-iconpicker-tabs';
  const body = document.createElement('div');
  body.className = 'nbe-iconpicker-body';
  const makeTab = (label: string, render: () => void, active = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nbe-iconpicker-tab' + (active ? ' nbe-active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      for (const other of tabs.children) other.classList.remove('nbe-active');
      b.classList.add('nbe-active');
      render();
    });
    tabs.append(b);
    if (active) render();
  };

  // --- emoji tab
  const renderEmoji = () => {
    body.replaceChildren();
    const search = document.createElement('input');
    search.className = 'nbe-iconpicker-search';
    search.placeholder = labels.iconSearch;
    const grid = document.createElement('div');
    grid.className = 'nbe-iconpicker-groups';
    /*
     * One listener for the whole grid, not one per cell: the full catalogue is
     * 1914 emoji, and a picker that installs two thousand closures every time
     * a letter is typed is a picker that stutters. The emoji is on the button,
     * which is the only state the handler needs.
     */
    grid.addEventListener('mousedown', (e) => e.preventDefault());
    grid.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest('.nbe-iconpicker-emoji') as HTMLElement | null;
      if (!cell) return;
      options.onPick(cell.textContent ?? '');
      close();
    });
    const paint = (query: string) => {
      const q = fold(query.trim());
      // both languages at once: « fusée » and « rocket » are the same emoji,
      // and a reader should not have to know which one the picker was written in
      const strict = (entry: EmojiEntry) =>
        !q || searchable(entry).all.includes(q) || entry[0] === query.trim();
      let found = catalogue.map((group) => group.items.filter(strict));
      /*
       * Nothing? Then the query was a spelling, not a word — try it as letters
       * in order before telling someone their emoji does not exist. Second
       * pass, never first: an exact match must never be buried under a fuzzy
       * one, and the loose rule costs nothing on a query that already worked.
       */
      if (q.length > 2 && !found.some((items) => items.length))
        found = catalogue.map((group) =>
          group.items
            .map((entry) => [fuzzySpan(searchable(entry).names, q), entry] as const)
            // twice the query plus two: a word with a few letters missing, not
            // five letters scattered across a sentence
            .filter(([span]) => span > 0 && span <= q.length * 2 + 2)
            .sort((a, b) => a[0] - b[0])
            .map(([, entry]) => entry),
        );

      grid.replaceChildren();
      for (const [at, group] of catalogue.entries()) {
        const matches = found[at]!;
        if (!matches.length) continue;
        const title = document.createElement('div');
        title.className = 'nbe-iconpicker-grouplabel';
        title.textContent = group.label;
        const row = document.createElement('div');
        row.className = 'nbe-iconpicker-grid';
        for (const entry of matches) {
          const cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'nbe-iconpicker-emoji' + (options.current === entry[0] ? ' nbe-active' : '');
          cell.textContent = entry[0];
          // the name is the accessible one and the tooltip both — 1914 unnamed
          // buttons is a grid a screen reader cannot read out
          cell.title = entry[1] ?? '';
          cell.setAttribute('aria-label', entry[1] ?? entry[0]);
          row.append(cell);
        }
        grid.append(title, row);
      }
      if (!grid.children.length) {
        const none = document.createElement('div');
        none.className = 'nbe-iconpicker-empty';
        none.textContent = labels.iconNoResult;
        grid.append(none);
      }
    };
    search.addEventListener('input', () => paint(search.value));
    search.addEventListener('keydown', (e) => e.stopPropagation());
    paint('');
    body.append(search, grid);
    search.focus();
  };

  // --- image tab
  const renderImage = () => {
    body.replaceChildren();
    const zone = createDropZone({
      label: labels.iconChooseImage,
      icon: 'image',
      urlPlaceholder: labels.iconPasteUrl,
      onFile: async (file) => {
        const src = options.storeImage ? await options.storeImage(file) : await fileToDataUrl(file);
        options.onPick(src);
        close();
      },
      onUrl: (url) => {
        options.onPick(url);
        close();
      },
    });
    const hint = document.createElement('div');
    hint.className = 'nbe-iconpicker-hint';
    hint.textContent = options.storeImage ? labels.iconImageStored : labels.iconImageInline;
    body.append(zone, hint);
  };

  if (options.imageOnly) {
    renderImage();
    root.append(body);
  } else {
    makeTab(labels.iconEmojiTab, renderEmoji, true);
    makeTab(labels.iconImageTab, renderImage);
    root.append(tabs, body);
  }

  if (options.onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nbe-iconpicker-remove';
    remove.textContent = options.removeLabel ?? labels.iconRemove;
    remove.addEventListener('click', () => {
      options.onRemove!();
      close();
    });
    root.append(remove);
  }

  mountPortal(root);
  stopAuto = autoUpdate(root, getAnchor, { placement: 'bottom-start' });
  stopDismiss = pushOverlay({ el: root, close });
  /*
   * Focus the field, now that there is a document to focus in: `renderEmoji`
   * asks for it too, which is right when a tab is switched and useless here —
   * it runs while the picker is still being assembled, and `focus()` on an
   * element outside the document does nothing at all. So the picker opened
   * with the caret wherever it already was, and the first thing anyone does
   * with an emoji picker is type.
   */
  root.querySelector<HTMLInputElement>('.nbe-iconpicker-search')?.focus();

  return { close };
}
