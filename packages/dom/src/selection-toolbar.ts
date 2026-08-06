import type { Mark } from "@nbe/core";
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
import {
  attachTooltip,
  createMenu,
  dismissedBy,
  positionFloating,
  type AnchorRect,
  type MenuEntry,
} from "./ui";
import { COLORS } from "./colors";
import { isActiveTarget, TURN_INTO } from "./block-types";

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

const FORMATS: FormatButton[] = [
  { mark: "bold", label: "B", title: "Gras · ⌘B", className: "nbe-fmt-bold" },
  {
    mark: "italic",
    label: "i",
    title: "Italique · ⌘I",
    className: "nbe-fmt-italic",
  },
  {
    mark: "underline",
    label: "U",
    title: "Souligné · ⌘U",
    className: "nbe-fmt-underline",
  },
  {
    mark: "strike",
    label: "S",
    title: "Barré · ⌘⇧S",
    className: "nbe-fmt-strike",
  },
  { mark: "code", label: "<>", title: "Code · ⌘E", className: "nbe-fmt-code" },
];

export function attachSelectionToolbar(view: EditorView): () => void {
  const editor = view.editor;
  const bar = document.createElement("div");
  bar.className = "nbe-seltoolbar";
  bar.dataset["nbeUi"] = "";
  bar.setAttribute("role", "toolbar");
  let visible = false;
  let suppressed = false; // while a sub-menu of the toolbar is open

  /** The active text range, single-block or spanning several. */
  const range = (): ResolvedRange | null => {
    const sel = editor.selection;
    if (sel?.kind !== "text" || isCollapsed(sel)) return null;
    const resolved = resolveTextRange(editor);
    if (!resolved) return null;
    if (resolved.single && resolved.startOffset === resolved.endOffset)
      return null;
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
    label: string,
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

  const openSubMenu = (anchor: HTMLElement, entries: MenuEntry[]) => {
    suppressed = true;
    const menu = createMenu({
      className: "nbe-seltoolbar-menu",
      onClose: () => {
        suppressed = false;
        update();
      },
    });
    menu.update(entries);
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

  const linkEntry = (r: ResolvedRange): MenuEntry => {
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
          TURN_INTO.map((t) => ({
            label: t.label,
            icon: t.icon,
            hint: isActiveTarget(t, block) ? "✓" : undefined,
            onSelect: () => turnInto(editor, block.id, t.type, t.props),
          })),
        );
      },
      "nbe-seltoolbar-turn",
    );
    turnSep = divider();
    bar.append(turnBtn, turnSep);

    for (const fmt of FORMATS) {
      const b = button(fmt.label, fmt.title, () => applyMark(fmt.mark), fmt.className);
      formatBtns.set(fmt.mark, b);
      bar.append(b);
    }

    linkBtn = button(
      "🔗",
      "Lien · ⌘K",
      () => {
        const r = range();
        if (r) openSubMenu(linkBtn!, [linkEntry(r)]);
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
      turnBtn!.textContent = `${TURN_INTO.find((t) => isActiveTarget(t, block))?.label ?? "Texte"} ▾`;
    }

    for (const fmt of FORMATS) {
      formatBtns.get(fmt.mark)?.classList.toggle("nbe-active", rangeHasMark(editor, fmt.mark));
    }
    linkBtn!.classList.toggle("nbe-active", rangeHasMark(editor, "link"));
  };

  const divider = (): HTMLElement => {
    const d = document.createElement("span");
    d.className = "nbe-seltoolbar-sep";
    return d;
  };

  const show = () => {
    const rect = anchorRect();
    if (!rect) return hide();
    if (!visible) {
      document.body.append(bar);
      visible = true;
    }
    render();
    positionFloating(bar, rect, { placement: "top-start", offset: 8 });
  };

  const hide = () => {
    if (!visible) return;
    visible = false;
    bar.remove();
  };

  const update = () => {
    if (suppressed) return;
    if (range()) show();
    else hide();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && visible && !suppressed) hide();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && range()) {
      e.preventDefault();
      const r = range()!;
      const btn = bar.querySelector(
        ".nbe-seltoolbar-link",
      ) as HTMLElement | null;
      if (btn) openSubMenu(btn, [linkEntry(r)]);
    }
  };

  const unsubSelection = editor.onSelection(() => update());
  const unsubChange = editor.on(() => update());
  // mouse-driven selections settle on mouseup; selectionchange fires mid-drag
  const onMouseUp = () => setTimeout(update, 0);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("scroll", update, { capture: true, passive: true });
  window.addEventListener("resize", update);
  view.content.addEventListener("keydown", onKeyDown);

  return () => {
    unsubSelection();
    unsubChange();
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("scroll", update, { capture: true });
    window.removeEventListener("resize", update);
    view.content.removeEventListener("keydown", onKeyDown);
    hide();
  };
}
