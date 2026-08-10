import type { Mark } from "@nbe/core";
import { mountPortal } from './ui/portal';
import {
  getBlock,
  isCollapsed,
  rangeHasMark,
  rangeInBlock,
  resolveTextRange,
  sliceRuns,
  toggleMarkRange,
  turnInto,
  type ResolvedRange,
} from "@nbe/core";
import type { EditorView } from "./view";
import { selectInlineText } from './selection';
import {
  attachTooltip,
  createMenu,
  dismissedBy,
  icon,
  positionFloating,
  type AnchorRect,
  type MenuEntry,
} from "./ui";
import { COLORS } from "./colors";
import type { EditorLabels } from "./labels";
import { isActiveTarget, turnIntoTargets } from "./block-types";
import { findScrollParent } from "./ui";
import { isMod, shortcut } from "./keymap";
import { viewOf } from "./block-view";

/**
 * Floating format toolbar on text selection (Medium / Notion). It never takes
 * focus — every control preventDefaults mousedown — so the selection it acts
 * on stays alive while the user clicks it.
 */

interface FormatButton {
  mark: string;
  label: string;
  title: string;
  className?: string;
}

/** Built per view: labels are per view, shortcuts are not. */
const formats = (labels: EditorLabels): FormatButton[] => [
  { mark: 'bold', label: 'B', title: `${labels.bold} · ${shortcut('Mod', 'B')}`, className: 'nbe-fmt-bold' },
  { mark: 'italic', label: 'i', title: `${labels.italic} · ${shortcut('Mod', 'I')}`, className: 'nbe-fmt-italic' },
  { mark: 'underline', label: 'U', title: `${labels.underline} · ${shortcut('Mod', 'U')}`, className: 'nbe-fmt-underline' },
  { mark: 'strike', label: 'S', title: `${labels.strikethrough} · ${shortcut('Mod', 'Shift', 'S')}`, className: 'nbe-fmt-strike' },
  { mark: 'superscript', label: 'x²', title: `${labels.superscript} · ${shortcut('Mod', '.')}`, className: 'nbe-fmt-superscript' },
  { mark: 'subscript', label: 'x₂', title: `${labels.subscript} · ${shortcut('Mod', ',')}`, className: 'nbe-fmt-subscript' },
  { mark: 'code', label: '<>', title: `${labels.inlineCode} · ${shortcut('Mod', 'E')}`, className: 'nbe-fmt-code' },
];

export function attachSelectionToolbar(view: EditorView): () => void {
  const labels = view.labels;
  const FORMAT_BUTTONS = formats(labels);
  const editor = view.editor;
  const bar = document.createElement("div");
  bar.className = "nbe-seltoolbar";
  bar.dataset["nbeUi"] = "";
  bar.setAttribute("role", "toolbar");
  let visible = false;
  let suppressed = false; // while a sub-menu of the toolbar is open

  /**
   * Whether a block wants this bar over it.
   *
   * @remarks
   * `BlockView.formatToolbar`, falling back to the schema's `literal`: a block
   * whose text is characters rather than markup has nothing the bar can do to
   * it. Every block in the range has to agree — a selection that starts in a
   * paragraph and ends in a code block is still partly formattable, but a bar
   * that silently formats half of what is highlighted is the worse answer.
   */
  const formattable = (id: string): boolean => {
    const type = getBlock(editor.doc, id).type;
    return viewOf(view.plugins.get(type))?.formatToolbar ?? !editor.schema.get(type).literal;
  };

  /** The active text range, single-block or spanning several. */
  const range = (): ResolvedRange | null => {
    const sel = editor.selection;
    if (sel?.kind !== "text" || isCollapsed(sel)) return null;
    const resolved = resolveTextRange(editor);
    if (!resolved) return null;
    if (resolved.single && resolved.startOffset === resolved.endOffset)
      return null;
    if (!resolved.blocks.every(formattable)) return null;
    return resolved;
  };

  const anchorRect = (): AnchorRect | null => {
    const dom = document.getSelection();
    if (!dom || dom.rangeCount === 0) return null;
    const rect = dom.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  };

  const button = (
    // a Node as readily as a string: every other control here is a glyph typed
    // by hand, and the comment one is the editor's own `message-square`, so it
    // reads as the same affordance as the gutter's bubble
    label: string | Node,
    title: string,
    onClick: () => void,
    className = "",
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `nbe-seltoolbar-btn ${className}`.trim();
    b.title = title;
    b.append(label);
    attachTooltip(b, title, { delayMs: 300 });
    // never let the toolbar steal the selection it is acting on
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (dismissedBy(b)) return; // pressing an open popover's trigger closes it
      onClick();
    });
    return b;
  };

  const applyMark = (type: string, attrs?: Record<string, unknown>) => {
    toggleMarkRange(editor, type, attrs);
    render(); // active states change in place
    view.syncDomSelection();
  };

  const openSubMenu = (anchor: HTMLElement, entries: MenuEntry[] | ((close: () => void) => MenuEntry[])) => {
    suppressed = true;
    const menu = createMenu({
      className: "nbe-seltoolbar-menu",
      onClose: () => {
        suppressed = false;
        update();
      },
    });
    // a form inside the menu needs to be able to dismiss it — applying a link
    // and leaving the field sitting open is how you end up with two of them
    menu.update(typeof entries === "function" ? entries(() => menu.close()) : entries);
    menu.open(() => anchor.getBoundingClientRect(), {
      placement: "bottom-start",
    });
  };

  const colorEntries = (): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { kind: "section", label: "Couleur du texte" },
    ];
    const swatchRow = (kind: "color" | "background") => {
      const row = document.createElement("div");
      row.className = "nbe-menu-swatches";
      for (const c of COLORS) {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "nbe-swatch";
        sw.title = c.label;
        sw.textContent = "A";
        if (kind === "color") sw.style.color = c.text;
        else {
          sw.style.background = c.background;
          if (c.name === "default") sw.style.color = "rgba(55,53,47,0.4)";
        }
        sw.addEventListener("mousedown", (e) => e.preventDefault());
        sw.addEventListener("click", () => {
          const markType = kind === "color" ? "color" : "background";
          const present = rangeHasMark(editor, markType);
          if (c.name === "default") {
            if (present) applyMark(markType); // toggling it off removes the colour
            return;
          }
          // clear any existing colour of the same kind, then apply the new one
          if (present) applyMark(markType);
          applyMark(markType, { color: c.name });
        });
        row.append(sw);
      }
      return row;
    };
    entries.push({ kind: "custom", el: swatchRow("color") });
    entries.push({ kind: "section", label: "Surlignage" });
    entries.push({ kind: "custom", el: swatchRow("background") });
    return entries;
  };

  const linkEntry = (r: ResolvedRange, close: () => void): MenuEntry => {
    const wrap = document.createElement("div");
    wrap.className = "nbe-seltoolbar-linkform";
    const input = document.createElement("input");
    input.className = "nbe-db-input";
    input.placeholder = "https://…";
    const first = rangeInBlock(editor, r, r.startBlockId);
    const block = getBlock(editor.doc, r.startBlockId);
    const existing = sliceRuns(
      block.text ?? [],
      first.from,
      first.to,
    )[0]?.marks?.find((m: Mark) => m.type === "link");
    input.value = String(existing?.attrs?.["href"] ?? "");
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      e.preventDefault();
      const href = input.value.trim();
      if (rangeHasMark(editor, "link")) applyMark("link");
      if (href) applyMark("link", { href });
      close();
    });
    wrap.append(input);
    return { kind: "custom", el: wrap };
  };

  /*
   * The toolbar is built ONCE and then only has its state refreshed.
   * Rebuilding the buttons on every update replaced the element the pointer
   * was travelling toward, so `mouseenter` never landed and tooltips simply
   * never appeared — and each rebuild orphaned the previous listeners.
   */
  let built = false;
  let turnBtn: HTMLButtonElement | null = null;
  let turnSep: HTMLElement | null = null;
  const formatBtns = new Map<string, HTMLButtonElement>();
  let linkBtn: HTMLButtonElement | null = null;
  let commentButton: HTMLButtonElement | null = null;

  const build = () => {
    if (built) return;
    built = true;

    turnBtn = button(
      "Texte ▾",
      "Transformer en",
      () => {
        const r = range();
        if (!r) return;
        const block = getBlock(editor.doc, r.startBlockId);
        openSubMenu(
          turnBtn!,
          turnIntoTargets(view).map((t) => ({
            label: t.label,
            icon: t.icon,
            hintIcon: isActiveTarget(t, block) ? "check" : undefined,
            onSelect: () => turnInto(editor, block.id, t.type, t.props),
          })),
        );
      },
      "nbe-seltoolbar-turn",
    );
    turnSep = divider();
    bar.append(turnBtn, turnSep);

    for (const fmt of FORMAT_BUTTONS) {
      const b = button(fmt.label, fmt.title, () => applyMark(fmt.mark), fmt.className);
      formatBtns.set(fmt.mark, b);
      bar.append(b);
    }

    linkBtn = button(
      "link",
      `${labels.link} · ${shortcut('Mod', 'K')}`,
      () => {
        const r = range();
        if (r) openSubMenu(linkBtn!, (close) => [linkEntry(r, close)]);
      },
      "nbe-seltoolbar-link",
    );
    bar.append(linkBtn, divider());

    const colorBtn = button(
      "A ▾",
      "Couleur et surlignage",
      () => openSubMenu(colorBtn, colorEntries()),
      "nbe-seltoolbar-color",
    );
    bar.append(colorBtn);

    /*
     * Comment on what is selected.
     *
     * The gutter button has always meant "discuss this block", and that is a
     * real thing to want — but the thing people actually argue about is a
     * sentence. Only offered with an `onComment` host, and only for a range
     * inside one block: a highlight that starts in one paragraph and ends in
     * another is two anchors and one discussion, which is a different feature
     * and not this one.
     */
    if (view.options.onComment) {
      const commentBtn = button(
        icon("message-square", { size: 14 }),
        labels.addComment,
        () => {
          const r = range();
          if (!r?.single) return;
          const at = rangeInBlock(editor, r, r.startBlockId);
          /*
           * A live `Range` over the selected words, cloned before the panel
           * takes the selection away. It re-measures on every scroll, which a
           * captured rect cannot — and the words are what the discussion is
           * about, so that is where the panel belongs.
           */
          const dom = document.getSelection();
          const live = dom?.rangeCount ? dom.getRangeAt(0).cloneRange() : null;
          view.options.onComment?.(r.startBlockId, view.options.commentAuthor ?? null, {
            range: { from: at.from, to: at.to },
            getAnchor: () => live?.getBoundingClientRect() ?? null,
          });
        },
        "nbe-seltoolbar-comment",
      );
      bar.append(divider(), commentBtn);
      commentButton = commentBtn;
    }
  };

  /** Refresh labels and active states in place — never replace nodes. */
  const render = () => {
    const r = range();
    if (!r) return;
    build();
    const block = getBlock(editor.doc, r.startBlockId);

    // turn-into is single-block by nature
    const showTurn = r.single;
    turnBtn!.style.display = showTurn ? "" : "none";
    turnSep!.style.display = showTurn ? "" : "none";
    if (showTurn) {
      turnBtn!.textContent = `${turnIntoTargets(view).find((t) => isActiveTarget(t, block))?.label ?? "Texte"} ▾`;
    }

    for (const fmt of FORMAT_BUTTONS) {
      formatBtns.get(fmt.mark)?.classList.toggle("nbe-active", rangeHasMark(editor, fmt.mark));
    }
    linkBtn!.classList.toggle("nbe-active", rangeHasMark(editor, "link"));
    // a comment anchors in one block; across blocks the button would lie
    if (commentButton) {
      commentButton.style.display = r.single ? "" : "none";
      (commentButton.previousElementSibling as HTMLElement | null)?.style.setProperty(
        "display",
        r.single ? "" : "none",
      );
    }
  };

  const divider = (): HTMLElement => {
    const d = document.createElement("span");
    d.className = "nbe-seltoolbar-sep";
    return d;
  };

  /**
   * True when the selection has scrolled out of the box the editor occupies.
   *
   * @remarks
   * The bar is portaled to `<body>` so no `overflow` inside the editor can
   * clip it — which is what makes it visible over a table's own scroller, and
   * what let it float over the *host's* header once the text it points at had
   * scrolled away: `computePosition` clamps a floater into the viewport, so a
   * selection above the fold pinned the bar to the top of the window. It has
   * to be clipped by the editor even though it is not inside it, so the test
   * is done here rather than left to CSS.
   */
  const outOfView = (rect: { top: number; bottom: number }): boolean => {
    const scroller = findScrollParent(view.content);
    const paging = scroller === document.scrollingElement || scroller === document.documentElement;
    const port = paging
      ? { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight }
      : scroller.getBoundingClientRect();
    // the bar sits *above* the selection, so it needs its own height of room
    return rect.bottom < port.top + bar.offsetHeight || rect.top > port.bottom;
  };

  const show = () => {
    const rect = anchorRect();
    if (!rect) return hide();
    if (visible && outOfView(rect)) return hide();
    if (!visible) {
      mountPortal(bar);
      visible = true;
    }
    render();
    if (outOfView(rect)) return hide();
    positionFloating(bar, rect, { placement: "top-start", offset: 8 });
  };

  const hide = () => {
    if (!visible) return;
    visible = false;
    bar.remove();
  };

  const update = () => {
    if (suppressed) return;
    // never float over a selection still being dragged: the router says when
    // one is in flight, which is what the old mouseup + setTimeout(0) guessed
    if (view.gesture) return hide();
    if (range()) show();
    else hide();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Escape is not handled here: the keymap escalates a text selection to a
    // block selection, and this bar hides because there is no range left. One
    // link in the chain, not a competing handler.
    if (isMod(e) && e.key.toLowerCase() === "k") {
      /*
       * A caret *inside* a link is the common way to reach ⌘K — you notice the
       * URL is wrong while reading it, and nothing is selected. Selecting the
       * link first is what the hover card's "edit" already did, so ⌘K does the
       * same rather than asking the user to select the words by hand.
       *
       * With no selection and no link under the caret there is nothing to make
       * into a link, so the key falls through untouched.
       */
      if (!range()) {
        const node = document.getSelection()?.focusNode;
        const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
        const anchor = el?.closest("a.nbe-m-link");
        if (!anchor || !selectInlineText(view, anchor)) return;
      }
      const r = range();
      if (!r) return;
      e.preventDefault();
      const btn = bar.querySelector(
        ".nbe-seltoolbar-link",
      ) as HTMLElement | null;
      if (btn) openSubMenu(btn, (close) => [linkEntry(r, close)]);
    }
  };

  const unsubSelection = editor.onSelection(() => update());
  const unsubChange = editor.on(() => update());
  // mouse-driven selections settle when the gesture ends, not on a timer
  const unsubGesture = view.onGestureEnd(() => update());
  document.addEventListener("scroll", update, { capture: true, passive: true });
  window.addEventListener("resize", update);
  view.content.addEventListener("keydown", onKeyDown);

  return () => {
    unsubSelection();
    unsubChange();
    unsubGesture();
    document.removeEventListener("scroll", update, { capture: true });
    window.removeEventListener("resize", update);
    view.content.removeEventListener("keydown", onKeyDown);
    hide();
  };
}
