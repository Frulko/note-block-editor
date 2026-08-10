import { deleteBlocks, moveBlocksVertical, toggleChecked, toggleMarkRange, turnInto } from '@nbe/core';
import type { CarnetView } from './view';

/**
 * Obsidian's own Format and Insert menus, pointed at this editor.
 *
 * @remarks
 * Those menus — and the mobile toolbar, and every hotkey bound to them — issue
 * `editor:*` commands whose callbacks require a `MarkdownView`. In a Carnet
 * note they are simply inapplicable, so the menu is there and does nothing,
 * which is the least explicable kind of broken.
 *
 * A table, and it is the whole of it: each id names an editor command that
 * already exists. What is *not* here is as deliberate — `editor:insert-link`
 * wants a dialog this plugin does not own (⌘K in the editor does), and the
 * maths and Mermaid entries want blocks a vault may not have registered. An
 * entry that returns false falls through to Obsidian, so an unhandled command
 * behaves exactly as it did before.
 *
 * Every action checks the schema before it runs: a vault whose plugin set has
 * no `code` block must not be told it turned something into one.
 *
 * @module
 */
type HostCommand = (view: CarnetView) => boolean;

const mark = (type: string, attrs?: Record<string, unknown>): HostCommand => (v) => {
  const parts = v.parts();
  if (!parts) return false;
  return toggleMarkRange(parts.editor, type, attrs);
};

const turn = (type: string, props?: Record<string, unknown>): HostCommand => (v) => {
  const parts = v.parts();
  const ids = v.targets();
  if (!parts || !ids.length || !parts.editor.schema.has(type)) return false;
  for (const id of ids) turnInto(parts.editor, id, type, props);
  parts.view.syncDomSelection();
  return true;
};

export const HOST_COMMANDS: Record<string, HostCommand> = {
  'editor:toggle-bold': mark('bold'),
  'editor:toggle-italics': mark('italic'),
  'editor:toggle-strikethrough': mark('strike'),
  'editor:toggle-highlight': mark('background', { color: 'yellow' }),
  'editor:toggle-code': mark('code'),
  'editor:toggle-blockquote': turn('quote'),
  'editor:toggle-bullet-list': turn('bulleted_list_item'),
  'editor:toggle-numbered-list': turn('numbered_list_item'),
  'editor:toggle-checklist-status': (v) => {
    const parts = v.parts();
    return !!parts && toggleChecked(parts.editor, v.targets());
  },
  'editor:insert-callout': turn('callout'),
  'editor:insert-codeblock': turn('code'),
  'editor:insert-horizontal-rule': turn('divider'),
  'editor:swap-line-up': (v) => {
    const parts = v.parts();
    return !!parts && moveBlocksVertical(parts.editor, v.targets(), 'up');
  },
  'editor:swap-line-down': (v) => {
    const parts = v.parts();
    return !!parts && moveBlocksVertical(parts.editor, v.targets(), 'down');
  },
  'editor:delete-paragraph': (v) => {
    const parts = v.parts();
    const ids = v.targets();
    if (!parts || !ids.length) return false;
    deleteBlocks(parts.editor, ids);
    parts.view.syncDomSelection();
    return true;
  },
};

// `editor:set-heading-0` … `-6`, which is seven near-identical lines otherwise.
// Levels above three are clamped: the model has three, and a silent `level: 6`
// would render as an h1 and export as one
for (let level = 0; level <= 6; level++) {
  HOST_COMMANDS[`editor:set-heading-${level}`] =
    level === 0 ? turn('paragraph') : turn('heading', { level: Math.min(3, level) });
}
