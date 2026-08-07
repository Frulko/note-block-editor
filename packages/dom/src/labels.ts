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
  /**
   * Placeholder shown in an empty block, by block type.
   *
   * @remarks
   * A block spec may declare its own `placeholder`, but a spec lives in core,
   * which has no notion of language — so a schema string is a fallback, not a
   * translation. Anything here wins. A type with no entry and no spec
   * placeholder simply shows nothing.
   */
  placeholders: Record<string, string>;
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

  // --- block toolbar (image, media) ---
  /** Add a caption under the image. Block toolbar. */
  addCaption: string;
  /** Edit the existing caption. Block toolbar. */
  editCaption: string;
  /** Placeholder in the caption field. */
  captionPlaceholder: string;
  /** Align left. Block toolbar. */
  alignLeft: string;
  /** Centre. Block toolbar. */
  alignCenter: string;
  /** Align right. Block toolbar. */
  alignRight: string;
  /** Download the image. Block toolbar. */
  downloadImage: string;
  /** Replace the image. Gutter menu. */
  replaceImage: string;

  // --- to-do and table actions ---
  /** Tick the checkbox. Gutter menu. */
  check: string;
  /** Untick the checkbox. Gutter menu. */
  uncheck: string;
  /** Insert a row above the caret's row. */
  insertRowAbove: string;
  /** Insert a row below the caret's row. */
  insertRowBelow: string;
  /** Delete the caret's row. */
  deleteRow: string;
  /** Insert a column left of the caret's column. */
  insertColumnLeft: string;
  /** Insert a column right of the caret's column. */
  insertColumnRight: string;
  /** Delete the caret's column. */
  deleteColumn: string;
  /** Toggle whether the first row is a header. */
  headerRow: string;
  /** Section heading naming the caret's row, e.g. "Row 2". Takes `{n}`. */
  rowN: string;
  /** Section heading naming the caret's column. Takes `{n}`. */
  columnN: string;

  // --- code block ---
  /** Section heading above the language list. */
  language: string;

  // --- announcements, continued ---
  /** Announced after a drag-and-drop move. */
  blockMoved: string;
  /** Announced after a side drop creates columns. */
  columnsCreated: string;

  // --- database chrome ---
  /** Shown when a database block points at a collection the host cannot find. */
  dbUnavailable: string;
  /** Toolbar button opening the property visibility list. */
  dbProperties: string;
  /** Adds a property to the collection. */
  dbNewProperty: string;
  /** Removes a property from the collection. */
  dbDeleteProperty: string;
  /** Shown on a board with no grouping property chosen. */
  dbPickGrouping: string;
  /** Shown on a rollup before a relation property exists. */
  dbNeedsRelation: string;
  /** Shown on a relation with no target collection chosen. */
  dbPickCollection: string;
  /** Section heading above the aggregated property. */
  dbRolledUpProperty: string;
  /** Exports the visible rows as CSV. */
  dbDownloadCsv: string;
  /** Exports the view definition as an Obsidian-shaped .base file. */
  dbDownloadBase: string;
  /** Hint under the formula editor. */
  dbFormulaHint: string;
  /** Announced after converting a block. Takes `{type}`. */
  turnedInto: string;
  /** The "no colour" entry in the palette. */
  colorDefault: string;
  /** Callout preset names, keyed by variant. */
  calloutNote: string;
  /** @see calloutNote */
  calloutInfo: string;
  /** @see calloutNote */
  calloutTip: string;
  /** @see calloutNote */
  calloutSuccess: string;
  /** @see calloutNote */
  calloutWarning: string;
  /** @see calloutNote */
  calloutDanger: string;
  /** @see calloutNote */
  calloutQuote: string;
  /** Placeholder in the formula editor. */
  dbFormulaPlaceholder: string;
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
  placeholders: {
    heading: 'Titre',
    bulleted_list_item: 'Élément',
    numbered_list_item: 'Élément',
    to_do: 'À faire',
    toggle: 'Bascule',
    quote: 'Citation',
    code: 'Code',
    callout: 'Encadré',
  },
  untitled: 'Sans titre',

  blockDuplicated: 'Bloc dupliqué',
  blockDeleted: 'Bloc supprimé',
  blockMovedUp: 'Bloc déplacé vers le haut',
  blockMovedDown: 'Bloc déplacé vers le bas',
  linkCopied: 'Lien copié',

  addCaption: 'Ajouter une légende',
  editCaption: 'Modifier la légende',
  captionPlaceholder: 'Légende…',
  alignLeft: 'Aligner à gauche',
  alignCenter: 'Centrer',
  alignRight: 'Aligner à droite',
  downloadImage: "Télécharger l'image",
  replaceImage: "Remplacer l'image",

  check: 'Cocher',
  uncheck: 'Décocher',
  insertRowAbove: 'Insérer une ligne au-dessus',
  insertRowBelow: 'Insérer une ligne en dessous',
  deleteRow: 'Supprimer la ligne',
  insertColumnLeft: 'Insérer une colonne à gauche',
  insertColumnRight: 'Insérer une colonne à droite',
  deleteColumn: 'Supprimer la colonne',
  headerRow: "Ligne d'en-tête",
  rowN: 'Ligne {n}',
  columnN: 'Colonne {n}',

  language: 'Langage',

  blockMoved: 'Bloc déplacé',
  columnsCreated: 'Colonnes créées',

  dbUnavailable: 'Base de données indisponible',
  dbProperties: 'Propriétés',
  dbNewProperty: 'Nouvelle propriété',
  dbDeleteProperty: 'Supprimer la propriété',
  dbPickGrouping: 'Choisis une propriété de groupement pour le board.',
  dbNeedsRelation: 'Crée d’abord une propriété Relation',
  dbPickCollection: 'Choisis une collection cible dans le menu de la propriété',
  dbRolledUpProperty: 'Propriété agrégée',
  dbDownloadCsv: 'Télécharger le CSV',
  dbDownloadBase: 'Télécharger la vue (.base)',
  dbFormulaHint: 'Entrée pour valider',
  turnedInto: 'Transformé en {type}',
  colorDefault: 'Défaut',
  calloutNote: 'Note',
  calloutInfo: 'Info',
  calloutTip: 'Astuce',
  calloutSuccess: 'Succès',
  calloutWarning: 'Attention',
  calloutDanger: 'Erreur',
  calloutQuote: 'Citation',
  dbFormulaPlaceholder: 'ex: prop("Prix") * prop("Quantité")',
};

/**
 * Merge a partial override over the defaults.
 *
 * @param overrides - Any subset of {@link EditorLabels}.
 *
 * @category Configuration
 */
export function resolveLabels(overrides?: Partial<EditorLabels>): EditorLabels {
  if (!overrides) return defaultLabels;
  return {
    ...defaultLabels,
    ...overrides,
    // `placeholders` is the one nested key, and a shallow spread would make
    // translating a single block type blank every other one
    placeholders: { ...defaultLabels.placeholders, ...overrides.placeholders },
  };
}

/**
 * Fill `{name}` placeholders in a label.
 *
 * @remarks
 * Deliberately not an ICU message formatter: the editor has exactly two
 * interpolated strings (`rowN`, `columnN`), both taking a bare number. A
 * formatting library for two strings is a dependency that earns nothing, and
 * the moment plurals or genders appear this should be replaced wholesale
 * rather than grown.
 *
 * @example
 * ```ts
 * format(labels.rowN, { n: 2 })   // 'Ligne 2'
 * ```
 *
 * @category Configuration
 */
export function format(label: string, values: Record<string, string | number>): string {
  return label.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
