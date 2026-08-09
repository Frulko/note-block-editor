import type { EditorLabels } from './labels';

/** Turn-into targets, shared by the block menu and the selection toolbar. */
export interface TurnIntoTarget {
  label: string;
  icon: string;
  type: string;
  props?: Record<string, unknown>;
}

/** Built per view: labels are per view. */
const builtinTurnInto = (labels: EditorLabels): TurnIntoTarget[] => [
  { label: labels.text, icon: 'pilcrow', type: 'paragraph' },
  { label: labels.heading1, icon: 'H1', type: 'heading', props: { level: 1 } },
  { label: labels.heading2, icon: 'H2', type: 'heading', props: { level: 2 } },
  { label: labels.heading3, icon: 'H3', type: 'heading', props: { level: 3 } },
  { label: labels.bulletedList, icon: '•', type: 'bulleted_list_item' },
  { label: labels.numberedList, icon: '1.', type: 'numbered_list_item' },
  { label: labels.todo, icon: 'square-check', type: 'to_do' },
  { label: labels.toggle, icon: 'chevron-right', type: 'toggle' },
  { label: labels.quote, icon: 'quote', type: 'quote' },
];

export function isActiveTarget(
  target: TurnIntoTarget,
  block: { type: string; props: Record<string, unknown> },
): boolean {
  if (block.type !== target.type) return false;
  if (target.type !== 'heading') return true;
  return block.props['level'] === target.props?.['level'];
}

/**
 * The built-in targets plus everything the registered plugins contribute.
 * Same shape as the slash menu: the array literal is the default, plugins
 * extend it, and nothing is privileged.
 */
export function turnIntoTargets(view: {
  labels: EditorLabels;
  plugins: { all(): Array<{ schema: { type: string }; view?: unknown }> };
}): TurnIntoTarget[] {
  const contributed: TurnIntoTarget[] = [];
  for (const plugin of view.plugins.all()) {
    const declared = (plugin.view as { turnInto?: unknown } | undefined)?.turnInto;
    if (!declared) continue;
    for (const entry of (Array.isArray(declared) ? declared : [declared]) as Array<{
      label: string;
      icon: string;
      props?: Record<string, unknown>;
    }>) {
      contributed.push({ label: entry.label, icon: entry.icon, type: plugin.schema.type, props: entry.props });
    }
  }
  return [...builtinTurnInto(view.labels), ...contributed];
}
