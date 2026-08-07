import { autoUpdate, type AnchorRect } from './position';
import { mountPortal } from './portal';
import { pushOverlay } from './overlay';
import { createDropZone, fileToDataUrl } from './upload';

/**
 * Icon picker: emoji grid with search, plus a custom image tab (uploaded
 * files become a data URL, or an opaque asset ref when the host stores them).
 * Used by callouts today; any block wanting an icon reuses this.
 */

interface EmojiGroup {
  label: string;
  /**
   * Explicit [emoji, keywords] pairs. Deliberately NOT a string of emojis
   * aligned to a parallel keyword array: ZWJ sequences and variation
   * selectors make any positional alignment silently drift.
   */
  items: Array<[string, string]>;
}

// a curated set — enough to be useful, small enough to need no dependency
const GROUPS: EmojiGroup[] = [
  {
    label: 'Fréquents',
    items: [
      ['💡', 'idée ampoule light'],
      ['⚠️', 'attention warning danger'],
      ['✅', 'ok validé check fait'],
      ['❌', 'erreur croix non'],
      ['📌', 'épingle punaise pin'],
      ['🔥', 'feu chaud hot urgent'],
      ['⭐️', 'étoile favori star'],
      ['❤️', 'coeur amour like'],
      ['🎯', 'cible objectif but'],
      ['🚀', 'fusée lancement rocket'],
      ['📝', 'note écrire memo'],
      ['🔔', 'cloche rappel notification'],
    ],
  },
  {
    label: 'Objets',
    items: [
      ['📁', 'dossier folder'],
      ['📂', 'dossier ouvert'],
      ['📄', 'document page fichier'],
      ['📅', 'calendrier date agenda'],
      ['📊', 'graphique stats chart'],
      ['📈', 'hausse croissance up'],
      ['📉', 'baisse déclin down'],
      ['🔍', 'recherche loupe search'],
      ['🔑', 'clé key accès'],
      ['🔒', 'cadenas fermé privé lock'],
      ['🔓', 'cadenas ouvert public'],
      ['📎', 'trombone pièce jointe'],
      ['✂️', 'ciseaux couper cut'],
      ['🖊️', 'stylo écrire pen'],
      ['📚', 'livres doc bibliothèque'],
      ['🗂️', 'classeur archives'],
    ],
  },
  {
    label: 'Symboles',
    items: [
      ['✨', 'étincelles magie nouveau'],
      ['🎉', 'fête célébration party'],
      ['🏆', 'trophée gagné succès'],
      ['🎨', 'palette design couleur'],
      ['🧠', 'cerveau réflexion idée'],
      ['⚙️', 'engrenage config réglage'],
      ['🔧', 'clé outil fix réparer'],
      ['🧪', 'test labo expérience'],
      ['💾', 'sauvegarde disquette save'],
      ['🌐', 'web monde global'],
      ['🔗', 'lien url link'],
      ['♻️', 'recycler refactor'],
      ['🚧', 'travaux wip chantier'],
      ['🛑', 'stop arrêt bloquant'],
      ['ℹ️', 'info information'],
      ['❓', 'question aide help'],
    ],
  },
  {
    label: 'Nature',
    items: [
      ['🌱', 'pousse plante début'],
      ['🌳', 'arbre nature'],
      ['🍀', 'trèfle chance luck'],
      ['🌊', 'vague mer flow'],
      ['💧', 'goutte eau'],
      ['☀️', 'soleil jour clair'],
      ['🌙', 'lune nuit sombre'],
      ['❄️', 'neige froid gel'],
      ['🐛', 'bug insecte problème'],
      ['🦋', 'papillon transformation'],
      ['🐢', 'tortue lent slow'],
      ['🐇', 'lapin rapide fast'],
    ],
  },
  {
    label: 'Personnes',
    items: [
      ['👤', 'personne user profil'],
      ['👥', 'groupe équipe team'],
      ['🙋', 'main levée question'],
      ['🧑‍💻', 'développeur code dev'],
      ['👏', 'applaudir bravo'],
      ['🤝', 'accord poignée deal'],
      ['💬', 'commentaire bulle chat'],
      ['🗣️', 'parler discussion voix'],
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


export interface IconPickerOptions {
  current?: string;
  onPick: (icon: string) => void;
  onRemove?: () => void;
  /** Store an uploaded image and return the src to persist (asset ref or data URL). */
  storeImage?: (file: File) => Promise<string>;
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
    search.placeholder = 'Rechercher une icône…';
    const grid = document.createElement('div');
    grid.className = 'nbe-iconpicker-groups';
    const paint = (query: string) => {
      const q = fold(query.trim());
      grid.replaceChildren();
      for (const group of GROUPS) {
        const matches = group.items.filter(
          ([emoji, keywords]) => !q || fold(keywords).includes(q) || emoji === query.trim(),
        );
        if (!matches.length) continue;
        const title = document.createElement('div');
        title.className = 'nbe-iconpicker-grouplabel';
        title.textContent = group.label;
        const row = document.createElement('div');
        row.className = 'nbe-iconpicker-grid';
        for (const [emoji] of matches) {
          const cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'nbe-iconpicker-emoji' + (options.current === emoji ? ' nbe-active' : '');
          cell.textContent = emoji;
          cell.addEventListener('mousedown', (e) => e.preventDefault());
          cell.addEventListener('click', () => {
            options.onPick(emoji);
            close();
          });
          row.append(cell);
        }
        grid.append(title, row);
      }
      if (!grid.children.length) {
        const none = document.createElement('div');
        none.className = 'nbe-iconpicker-empty';
        none.textContent = 'Aucune icône';
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
      label: 'Choisir une image',
      icon: 'image',
      urlPlaceholder: 'ou colle une URL, puis Entrée',
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
    hint.textContent = options.storeImage
      ? "L'image est stockée par l'application et référencée par le document."
      : 'Sans stockage configuré, l’image est intégrée en base64 dans le document.';
    body.append(zone, hint);
  };

  makeTab('Emoji', renderEmoji, true);
  makeTab('Image', renderImage);

  root.append(tabs, body);

  if (options.onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nbe-iconpicker-remove';
    remove.textContent = 'Retirer l’icône';
    remove.addEventListener('click', () => {
      options.onRemove!();
      close();
    });
    root.append(remove);
  }

  mountPortal(root);
  stopAuto = autoUpdate(root, getAnchor, { placement: 'bottom-start' });
  stopDismiss = pushOverlay({ el: root, close });

  return { close };
}
