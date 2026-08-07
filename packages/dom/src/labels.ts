/**
 * Every string the editor puts on screen.
 *
 * @remarks
 * This exists because the editor shipped with 76 French literals across 12
 * files, which makes it unusable in any other language — a hard blocker for
 * something meant to be embedded. The defaults stay French so nothing changes
 * for the existing demo; a host passes its own dictionary.
 *
 * It is a flat record rather than a nested tree on purpose: flat keys are
 * greppable, a missing key is a compile error, and a translator can diff two
 * dictionaries without walking a structure.
 *
 * @category Configuration
 */
export interface EditorLabels {
  // --- block menu (the ⋮⋮ gutter) ---
  /** Duplicate the block. Shown in the ⋮⋮ gutter menu. */
  duplicate: string;
  /** Delete the block. Gutter menu. */
  delete: string;
  /** Copy a URL anchored to this block. Gutter menu. */
  copyBlockLink: string;
  /** Move the block up one position. Gutter menu. */
  moveUp: string;
  /** Move the block down one position. Gutter menu. */
  moveDown: string;
  /** Section heading above a block type’s own actions. */
  thisBlock: string;
  /** Section heading above the block-type conversions. */
  turnInto: string;
  /** Section heading above the text colour swatches. */
  textColor: string;
  /** Section heading above the background swatches. */
  backgroundColor: string;

  // --- gutter buttons ---
  /** Tooltip on the gutter’s + button. */
  addBlock: string;
  /** Tooltip on the ⋮⋮ handle. Two lines: drag, and click. */
  dragHandle: string;

  // --- format toolbar ---
  /** Bold. Format toolbar, and the ⌘B tooltip. */
  bold: string;
  /** Italic. Format toolbar. */
  italic: string;
  /** Underline. Format toolbar. */
  underline: string;
  /** Strikethrough. Format toolbar. */
  strikethrough: string;
  /** Inline code. Format toolbar. */
  inlineCode: string;
  /** Add or edit a link. Format toolbar. */
  link: string;
  /** Remove the link, keeping its text. Link hover card. */
  removeLink: string;
  /** Edit the link target. Link hover card. */
  editLink: string;
  /** Open the link in a new tab. Link hover card. */
  openLink: string;

  // --- slash menu, for the built-in entries ---
  /** Plain paragraph. Slash menu and “Turn into”. */
  text: string;
  /** Level-1 heading. Slash menu and “Turn into”. */
  heading1: string;
  /** Level-2 heading. Slash menu and “Turn into”. */
  heading2: string;
  /** Level-3 heading. Slash menu and “Turn into”. */
  heading3: string;
  /** Bulleted list item. Slash menu and “Turn into”. */
  bulletedList: string;
  /** Numbered list item. Slash menu and “Turn into”. */
  numberedList: string;
  /** Checkbox item. Slash menu and “Turn into”. */
  todo: string;
  /** Collapsible item. Slash menu and “Turn into”. */
  toggle: string;
  /** Quote. Slash menu and “Turn into”. */
  quote: string;
  /** Code block. Slash menu and “Turn into”. */
  code: string;
  /** Image. Slash menu. */
  image: string;
  /** Table. Slash menu. */
  table: string;
  /** Horizontal rule. Slash menu. */
  divider: string;
  /** Sub-page link. Slash menu; hidden without an `onCreatePage` host. */
  page: string;
  /** Database view. Slash menu; hidden without a `database` host. */
  database: string;

  // --- placeholders ---
  /** Placeholder in an empty focused paragraph. */
  emptyParagraph: string;
  /** Stand-in for a page or row with no title yet. */
  untitled: string;

  // --- announcements (aria-live) ---
  /** Announced to screen readers after a duplicate. */
  blockDuplicated: string;
  /** Announced to screen readers after a delete. */
  blockDeleted: string;
  /** Announced to screen readers after moving up. */
  blockMovedUp: string;
  /** Announced to screen readers after moving down. */
  blockMovedDown: string;
  /** Announced to screen readers after copying a block link. */
  linkCopied: string;
}

/**
 * The shipped dictionary.
 *
 * @remarks
 * French, because that is what the editor was written in. Nothing about the
 * architecture privileges it — pass `labels` to replace any subset.
 *
 * @example
 * ```ts
 * new EditorView(el, editor, {
 *   labels: { bold: 'Bold · ⌘B', italic: 'Italic · ⌘I', delete: 'Delete' },
 * })
 * ```
 *
 * @category Configuration
 */
export const defaultLabels: EditorLabels = {
  duplicate: 'Dupliquer',
  delete: 'Supprimer',
  copyBlockLink: 'Copier le lien du bloc',
  moveUp: 'Déplacer vers le haut',
  moveDown: 'Déplacer vers le bas',
  thisBlock: 'Ce bloc',
  turnInto: 'Transformer en',
  textColor: 'Couleur du texte',
  backgroundColor: 'Couleur de fond',

  addBlock: 'Ajouter un bloc en dessous',
  dragHandle: 'Glisser pour déplacer\nCliquer pour ouvrir le menu',

  bold: 'Gras',
  italic: 'Italique',
  underline: 'Souligné',
  strikethrough: 'Barré',
  inlineCode: 'Code',
  link: 'Lien',
  removeLink: 'Retirer le lien',
  editLink: 'Modifier le lien',
  openLink: 'Ouvrir le lien',

  text: 'Texte',
  heading1: 'Titre 1',
  heading2: 'Titre 2',
  heading3: 'Titre 3',
  bulletedList: 'Liste à puces',
  numberedList: 'Liste numérotée',
  todo: 'Case à cocher',
  toggle: 'Toggle',
  quote: 'Citation',
  code: 'Code',
  image: 'Image',
  table: 'Tableau',
  divider: 'Séparateur',
  page: 'Page',
  database: 'Base de données',

  emptyParagraph: 'Écris quelque chose…',
  untitled: 'Sans titre',

  blockDuplicated: 'Bloc dupliqué',
  blockDeleted: 'Bloc supprimé',
  blockMovedUp: 'Bloc déplacé vers le haut',
  blockMovedDown: 'Bloc déplacé vers le bas',
  linkCopied: 'Lien copié',
};

/** Merge a partial override over the defaults. */
export function resolveLabels(overrides?: Partial<EditorLabels>): EditorLabels {
  return overrides ? { ...defaultLabels, ...overrides } : defaultLabels;
}
