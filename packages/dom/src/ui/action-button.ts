import { dismissedBy } from './overlay';
import { icon, type IconName } from './icons';
import { attachTooltip } from './tooltip';

export interface ActionButtonOptions {
  /**
   * Required, always. It becomes the accessible name AND the tooltip, so an
   * action can never ship without a label — the whole reason this factory
   * exists rather than each surface hand-rolling its buttons.
   */
  title: string;
  /** Icon name from the Lucide set. */
  icon?: IconName;
  /** Visible label, when the control is textual (or a custom node). */
  label?: string | Node;
  iconSize?: number;
  className?: string;
  /** Extra keyboard/reader hint appended to the tooltip, e.g. "⌘B". */
  shortcut?: string;
  /**
   * The button acts on the current text selection, so pressing it must not
   * move focus (chrome floating over a selection).
   */
  preserveSelection?: boolean;
  /**
   * The button opens a popover: a press that just dismissed one will not
   * reopen it, which is what makes the control read as a toggle.
   */
  popover?: boolean;
  tooltipDelay?: number;
  onClick: (event: MouseEvent, button: HTMLButtonElement) => void;
}

/**
 * The one way to build an action control in this editor.
 *
 * Every surface (block gutter, block toolbar, selection toolbar, link card,
 * database chrome, block-rendered affordances) goes through here, so tooltip,
 * accessible name, popover-toggle behaviour and selection preservation are
 * decided once instead of being remembered at ~40 call sites.
 */
export function createActionButton(options: ActionButtonOptions): HTMLButtonElement {
  const {
    title,
    icon: iconName,
    label,
    iconSize = 16,
    className,
    shortcut,
    preserveSelection = false,
    popover = false,
    tooltipDelay = 350,
    onClick,
  } = options;

  const button = document.createElement('button');
  button.type = 'button';
  if (className) button.className = className;
  button.setAttribute('aria-label', title);
  if (popover) button.setAttribute('aria-haspopup', 'true');

  if (iconName) button.append(icon(iconName, { size: iconSize }));
  if (label !== undefined) button.append(label);

  attachTooltip(button, shortcut ? `${title} · ${shortcut}` : title, { delayMs: tooltipDelay });

  if (preserveSelection) button.addEventListener('mousedown', (e) => e.preventDefault());

  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (popover && dismissedBy(button)) return;
    onClick(event, button);
  });

  return button;
}
