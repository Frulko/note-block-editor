/**
 * Callout presets. A variant is a named bundle of (icon, tint) so the common
 * cases are one click, while icon and colour stay independently editable —
 * picking either afterwards just clears the variant label, it never fights
 * the user's explicit choice.
 *
 * The names match Obsidian's callout types, so the markdown projection can
 * emit `> [!warning]` and round-trip (ARCHITECTURE §10).
 */
export interface CalloutPreset {
  name: string;
  label: string;
  icon: string;
  /** Palette name from colors.ts. */
  backgroundColor: string;
}

export const CALLOUT_PRESETS: CalloutPreset[] = [
  { name: 'note', label: 'Note', icon: '💡', backgroundColor: 'gray' },
  { name: 'info', label: 'Info', icon: 'ℹ️', backgroundColor: 'blue' },
  { name: 'tip', label: 'Astuce', icon: '🚀', backgroundColor: 'purple' },
  { name: 'success', label: 'Succès', icon: '✅', backgroundColor: 'green' },
  { name: 'warning', label: 'Attention', icon: '⚠️', backgroundColor: 'yellow' },
  { name: 'danger', label: 'Erreur', icon: '🛑', backgroundColor: 'red' },
  { name: 'quote', label: 'Citation', icon: '❝', backgroundColor: 'brown' },
];

export function presetByName(name: unknown): CalloutPreset | undefined {
  return typeof name === 'string' ? CALLOUT_PRESETS.find((p) => p.name === name) : undefined;
}
