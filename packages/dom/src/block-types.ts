/** Turn-into targets, shared by the block menu and the selection toolbar. */
export interface TurnIntoTarget {
  label: string;
  icon: string;
  type: string;
  props?: Record<string, unknown>;
}

export const TURN_INTO: TurnIntoTarget[] = [
  { label: 'Texte', icon: '¶', type: 'paragraph' },
  { label: 'Titre 1', icon: 'H1', type: 'heading', props: { level: 1 } },
  { label: 'Titre 2', icon: 'H2', type: 'heading', props: { level: 2 } },
  { label: 'Titre 3', icon: 'H3', type: 'heading', props: { level: 3 } },
  { label: 'Liste à puces', icon: '•', type: 'bulleted_list_item' },
  { label: 'Liste numérotée', icon: '1.', type: 'numbered_list_item' },
  { label: 'Case à cocher', icon: '☑', type: 'to_do' },
  { label: 'Toggle', icon: '▸', type: 'toggle' },
  { label: 'Citation', icon: '❝', type: 'quote' },
  { label: 'Callout', icon: '💡', type: 'callout' },
  { label: 'Code', icon: '⌨', type: 'code' },
];

export function isActiveTarget(
  target: TurnIntoTarget,
  block: { type: string; props: Record<string, unknown> },
): boolean {
  if (block.type !== target.type) return false;
  if (target.type !== 'heading') return true;
  return block.props['level'] === target.props?.['level'];
}
