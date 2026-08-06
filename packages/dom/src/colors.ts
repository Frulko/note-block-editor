export interface ColorDef {
  /** Stable key persisted in the document (never a raw CSS value). */
  name: string;
  label: string;
  /** CSS colour for text. */
  text: string;
  /** CSS colour for backgrounds (block tint or inline highlight). */
  background: string;
}

/**
 * The palette is a closed, named set: documents persist `name`, never a raw
 * CSS value. That keeps colours themeable (a dark mode can remap them), keeps
 * the markdown/static projections meaningful, and stops arbitrary CSS from
 * entering the model through a colour picker.
 */
export const COLORS: ColorDef[] = [
  { name: 'default', label: 'Défaut', text: 'inherit', background: 'transparent' },
  { name: 'gray', label: 'Gris', text: 'rgb(120,119,116)', background: 'rgb(241,241,239)' },
  { name: 'brown', label: 'Marron', text: 'rgb(159,107,83)', background: 'rgb(244,238,238)' },
  { name: 'orange', label: 'Orange', text: 'rgb(217,115,13)', background: 'rgb(251,236,221)' },
  { name: 'yellow', label: 'Jaune', text: 'rgb(203,145,47)', background: 'rgb(251,243,219)' },
  { name: 'green', label: 'Vert', text: 'rgb(68,131,97)', background: 'rgb(237,243,236)' },
  { name: 'blue', label: 'Bleu', text: 'rgb(51,126,169)', background: 'rgb(231,243,248)' },
  { name: 'purple', label: 'Violet', text: 'rgb(144,101,176)', background: 'rgb(244,240,247)' },
  { name: 'pink', label: 'Rose', text: 'rgb(193,76,138)', background: 'rgb(249,238,243)' },
  { name: 'red', label: 'Rouge', text: 'rgb(212,76,71)', background: 'rgb(253,235,236)' },
];

export function colorByName(name: unknown): ColorDef | undefined {
  return typeof name === 'string' ? COLORS.find((c) => c.name === name) : undefined;
}

/** CSS text colour for a persisted name, or undefined for the default. */
export function textColor(name: unknown): string | undefined {
  const color = colorByName(name);
  return color && color.name !== 'default' ? color.text : undefined;
}

/** CSS background for a persisted name, or undefined for none. */
export function backgroundColor(name: unknown): string | undefined {
  const color = colorByName(name);
  return color && color.name !== 'default' ? color.background : undefined;
}
