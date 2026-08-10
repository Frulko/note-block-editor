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
import { en } from './i18n/en';

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
  /** Tooltip on the right-hand comment button. */
  addComment: string;
  /** Open the threads on a commented block. `{n}` is how many there are. */
  openComments: string;

  // --- the comment bubble (`openCommentThread`) ---
  /** Placeholder of the field when the block has no comments yet. */
  commentPlaceholder: string;
  /** Placeholder of the same field once there is a discussion to join. */
  commentReply: string;
  /** The button that posts what was typed. */
  commentSend: string;
  /** Tooltip on a message’s bin. Removes that message, not the discussion. */
  commentDelete: string;
  /** Close a discussion, keeping it readable. */
  commentResolve: string;
  /** Undo that. */
  commentReopen: string;
  /** Shown as the author of a message written with no identity. */
  commentAnonymous: string;
  /** Placeholder of the find bar (opt-in `findFeature`). */
  find: string;
  /** Previous match. Find bar. */
  findPrevious: string;
  /** Next match. Find bar. */
  findNext: string;
  /** Close the find bar. */
  findClose: string;
  /** Shown when a search matches nothing. */
  findNone: string;
  /** The counter under the document. `{words}`, `{characters}`, `{minutes}`. */
  wordCount: string;
  /** The badge shown while `⌥⇧D` pins the chrome. */
  debugHold: string;

  // --- format toolbar ---
  /** Bold. Format toolbar, and the ⌘B tooltip. */
  bold: string;
  /** Italic. Format toolbar. */
  italic: string;
  /** Underline. Format toolbar. */
  underline: string;
  /** Strikethrough. Format toolbar. */
  strikethrough: string;
  /** Superscript. Format toolbar. */
  superscript: string;
  /** Subscript. Format toolbar. */
  subscript: string;
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
  /** Attach a file. Slash menu, and the empty file block's drop zone. */
  chooseFile: string;
  /** Shown instead of a file's name when the name was not recorded. */
  fileFallbackName: string;
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
  /**
   * Shown in place of a block whose plugin this editor has not registered.
   * Takes `{type}`, the block type as the document names it.
   */
  unknownBlock: string;

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
  /** Height of a framed surface. Block toolbar. */
  frameHeight: string;
  /** Show the frame filling the screen. Block toolbar. */
  fullscreen: string;
  /** Load a page that is held back until asked for. Button over the frame. */
  loadFrame: string;
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
  /** Toggle whether the first column is a header. Table toolbar. */
  headerColumn: string;
  /** Toggle whether the table spans the whole text column. Table toolbar. */
  fullWidth: string;
  /** Merge the selected cells into one. Cell selection bar. */
  mergeCells: string;
  /** Split a merged cell back into its slots. Cell selection bar. */
  unmergeCells: string;
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

  // --- the column layout ---
  /** The slash entry, and the toolbar button that changes the count. */
  columns: string;
  /** One entry of the count menu. `{n}` is the number. */
  columnsCount: string;
  /** The toolbar button that changes how the width is shared out. */
  columnsRatio: string;
  /** Every column the same width. */
  columnsEqual: string;
  columnsWideFirst: string;
  columnsWideLast: string;
  /** Only offered for an odd number of columns. */
  columnsWideMiddle: string;

  // --- the page link ---
  /** The slash entry that points a block at an existing page. */
  linkToPage: string;
  /** Placeholder of the picker's search field. */
  choosePage: string;
  /** Shown when the host's search comes back with nothing. */
  noPageFound: string;

  // --- what a pasted link becomes ---
  /** Heading of the menu offered after a URL is pasted. */
  pasteLinkAs: string;
  /** Turn it into a mention of the page it points at. Only when one is found. */
  pasteAsMention: string;
  /** Turn it into an embed block. */
  pasteAsEmbed: string;
  /** Turn it into an embed block showing a card. */
  pasteAsBookmark: string;
  /** Leave it as the link the paste already made. */
  pasteAsUrl: string;
  /** Block-menu entry on a paragraph whose whole text is one link. */
  convertToEmbed: string;

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
/**
 * The labels an editor uses when a host names none.
 *
 * @remarks
 * English — and it used to be French, which is the interesting part. The
 * editor was written in French because its first host is; a library whose
 * defaults are one team's language is one everyone else must translate before
 * they can read their own screen. The French pack is still here, complete, and
 * Carnet asks for it by name (`labels: fr`). See `./i18n`.
 */
export const defaultLabels: EditorLabels = en;

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
