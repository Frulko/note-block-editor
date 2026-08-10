import { childIndex, getBlock, plainText, textCaret, uuidv7, type Block, type BlockId } from '@nbe/core';
import type { EditorView } from './view';
import { triggerAnchor } from './caret';
import { createMenu, type MenuEntry } from './ui';

/**
 * What a link should become, asked at the moment it arrives.
 *
 * @remarks
 * A pasted URL has four plausible meanings and the editor cannot tell them
 * apart: the same `https://…` is a citation in a sentence, a video to watch
 * here, a bookmark to come back to, or a page in this vault. Guessing picks
 * wrong three times in four, and every wrong guess is an edit to undo — so the
 * paste does the safe thing (a link on its own text) and *then* offers the
 * other three, one keystroke away.
 *
 * Anchored to the end of the link rather than to the block, because that is
 * where the eye already is; the menu's own clamping keeps it in the window
 * when the link runs to the edge.
 *
 * Mention is offered only when the host can find a page of that name — a link
 * to a note is a mention, a link to a website is not, and an entry that turns
 * a URL into a wikilink pointing at nothing is worse than no entry.
 *
 * @category Interaction
 */
export interface LinkPasteOptions {
  blockId: BlockId;
  /** Where the link text starts and ends in the block. */
  from: number;
  to: number;
  href: string;
}

/**
 * A URL as short as it can be and still say where it goes.
 *
 * @remarks
 * The host, and the last thing on the path — `example.com/…/article`. Which is
 * what a reader of a sentence needs from a link: the scheme is noise, `www.` is
 * noise, and a forty-character tracking query in the middle of a paragraph is
 * worse than noise. The `href` keeps all of it.
 *
 * Shared with the hover card's rename field, which pre-fills with exactly this.
 *
 * @category Interaction
 */
export function shortenUrl(href: string): string {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '');
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return last ? `${host}/${last}` : host;
  } catch {
    return href;
  }
}

/** The page a URL might be, by the name at the end of it. */
function pageFor(view: EditorView, href: string): { pageId: string; title: string } | null {
  const search = view.options.onSearchPages;
  if (!search) return null;
  let name = '';
  try {
    name = decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return null;
  }
  name = name.replace(/\.md$/i, '');
  if (!name) return null;
  return search(name).find((page) => page.title.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Replace the pasted link with a block of `type`, carrying the URL. */
function becomeBlock(view: EditorView, at: LinkPasteOptions, props: Record<string, unknown>): void {
  const editor = view.editor;
  const block = editor.doc.blocks.get(at.blockId);
  if (!block) return;
  const alone = plainText(block.text).trim() === plainText(block.text).slice(at.from, at.to).trim();
  const made: Block = {
    id: uuidv7(),
    type: 'embed',
    version: 1,
    props,
    text: [],
    children: [],
    parentId: block.parentId,
  };
  editor.dispatch(
    (tx) => {
      // the link came out of the sentence it was pasted into; a block that held
      // nothing else goes with it rather than being left behind empty
      tx.op({ type: 'delete_text', id: at.blockId, from: at.from, to: at.to });
      tx.op({ type: 'insert_block', block: made, index: childIndex(editor.doc, at.blockId) + 1 });
      if (alone) tx.op({ type: 'delete_block', id: at.blockId });
    },
    { origin: 'input' },
  );
}

/**
 * Offer the treatments for a link that has just been pasted.
 *
 * @remarks
 * Does nothing without an `embed` block registered *and* nothing to offer:
 * a menu whose only entry is "leave it as it is" is a menu that should not
 * have opened.
 */
export function offerLinkTreatments(view: EditorView, at: LinkPasteOptions): void {
  const labels = view.labels;
  const editor = view.editor;
  const canEmbed = editor.schema.has('embed');
  const page = pageFor(view, at.href);
  if (!canEmbed && !page) return;

  const menu = createMenu({ className: 'nbe-linkpaste-menu' });
  const done = () => {
    menu.close();
    view.syncDomSelection();
  };

  /**
   * Whether the link is the whole paragraph, which decides what goes first.
   *
   * @remarks
   * Enter takes the first entry, so the order *is* the default — and the right
   * default depends on where the link landed. Alone on a line, a URL is
   * something you pasted to look at: the embed leads, as it always has. In the
   * middle of a sentence it is a reference, and turning it into a block would
   * tear the sentence in half — so there the inline treatments lead.
   *
   * Same test `becomeBlock` uses to decide whether to take the paragraph with
   * it, which is the same question asked from the other side.
   */
  const block = editor.doc.blocks.get(at.blockId);
  const whole = plainText(block?.text).trim();
  const alone = whole === whole.slice(at.from, at.to).trim();

  const entries: MenuEntry[] = [{ kind: 'section', label: labels.pasteLinkAs }];

  /** Keep the link, change what it reads as. */
  const rename = (label: string) => {
    editor.dispatch(
      (tx) => {
        tx.op({ type: 'delete_text', id: at.blockId, from: at.from, to: at.to });
        tx.op({
          type: 'insert_text',
          id: at.blockId,
          offset: at.from,
          runs: [{ text: label, marks: [{ type: 'link', attrs: { href: at.href } }] }],
        });
      },
      { origin: 'input', selection: textCaret(at.blockId, at.from + label.length) },
    );
    done();
  };

  /*
   * The two that keep the link *inline*, which is what a URL dropped into the
   * middle of a sentence usually is. Both are ordinary Markdown links with a
   * different text — `[example.com/article](https://…)` — so they need no
   * marker, no prop and no new syntax, and the file round-trips byte for byte.
   *
   * The short one is always offered: it is a string operation and needs
   * nothing. The title needs the network, and the network belongs to a host —
   * so it is absent rather than dead where nobody can answer, the same rule the
   * mention below already follows.
   */
  const inline: MenuEntry[] = [];
  const short = shortenUrl(at.href);
  if (short !== at.href) {
    inline.push({ label: labels.pasteAsShort, icon: 'link', hint: short, onSelect: () => rename(short) });
  }
  if (view.options.onResolveLink) {
    inline.push({
      label: labels.pasteAsTitle,
      icon: 'file-text',
      onSelect: () => {
        void Promise.resolve(view.options.onResolveLink?.(at.href))
          .then((meta) => {
            // no title is not an error: the link stays exactly as the paste
            // made it, which is the same thing choosing « Lien simple » does
            const title = meta?.title?.trim();
            if (title) rename(title);
            else done();
          })
          .catch(() => done());
      },
    });
  }
  // in a sentence, reading well is the likeliest intent, so it leads
  if (!alone) entries.push(...inline);

  if (page) {
    entries.push({
      label: labels.pasteAsMention,
      icon: 'file-text',
      onSelect: () => {
        editor.dispatch(
          (tx) => {
            tx.op({ type: 'delete_text', id: at.blockId, from: at.from, to: at.to });
            tx.op({
              type: 'insert_text',
              id: at.blockId,
              offset: at.from,
              runs: [
                {
                  text: page.title,
                  marks: [{ type: 'mention', attrs: { pageId: page.pageId, target: page.pageId } }],
                },
              ],
            });
          },
          { origin: 'input', selection: textCaret(at.blockId, at.from + page.title.length) },
        );
        done();
      },
    });
  }
  if (canEmbed) {
    entries.push(
      {
        label: labels.pasteAsEmbed,
        icon: 'workflow',
        onSelect: () => {
          becomeBlock(view, at, { src: at.href });
          menu.close();
        },
      },
      {
        label: labels.pasteAsBookmark,
        icon: 'link',
        onSelect: () => {
          becomeBlock(view, at, { src: at.href, mode: 'card' });
          menu.close();
        },
      },
    );
  }
  // alone on a line the block treatments lead, so these come after them
  if (alone) entries.push(...inline);
  // last, and named for what it is: the paste already did this, so choosing it
  // is choosing to change nothing
  entries.push({ label: labels.pasteAsUrl, icon: 'check', onSelect: done });
  menu.update(entries);
  menu.open(() => triggerAnchor(view, at.blockId, at.to), { placement: 'bottom-start' });
}

/**
 * The same offer, for a link that is already in the document.
 *
 * @remarks
 * A paragraph whose whole text is one link is a link somebody meant as a
 * block — the commonest way one arrives is a paste into an empty paragraph,
 * and the second commonest is a note written elsewhere. `null` when the block
 * is anything else.
 */
export function loneLink(view: EditorView, id: BlockId): LinkPasteOptions | null {
  const block = getBlock(view.editor.doc, id);
  if (block.type !== 'paragraph') return null;
  const runs = block.text ?? [];
  const text = plainText(runs).trim();
  if (!text) return null;
  const href = runs.find((run) => run.marks?.some((m) => m.type === 'link'))?.marks?.find((m) => m.type === 'link')
    ?.attrs?.['href'];
  // marked as a link, or plainly one: a URL typed into an empty paragraph
  // carries no mark until something links it
  const url = typeof href === 'string' && href ? href : /^https?:\/\/\S+$/i.test(text) ? text : null;
  if (!url) return null;
  return { blockId: id, from: 0, to: plainText(runs).length, href: url };
}
