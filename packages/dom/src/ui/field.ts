import { ESCAPE_SELF_ATTR } from './overlay';

/**
 * The form layer of the UI primitives.
 *
 * It exists because the two per-block-type registries that will become the
 * plugin API — `block-actions.ts` and `block-toolbar.ts` — already hand-roll
 * their inputs, and `database.ts` hand-rolls ten of them. A block author with
 * nothing to reach for writes raw DOM, and raw DOM then *is* the contract.
 *
 * Three rules every control here obeys, so no call site has to remember them:
 *
 * 1. **Escape belongs to the control.** A field inside a menu must cancel its
 *    own edit rather than close the menu, so everything here carries
 *    `data-nbe-escape-self` and the overlay stack yields to it.
 * 2. **Keys stay inside.** Editor keymaps listen on the content and menus
 *    navigate with arrows; a field that lets its keydown bubble gets its text
 *    interpreted as commands. Everything here stops propagation.
 * 3. **Commit is explicit.** Enter commits, Escape reverts, blur commits —
 *    once. Comparing against the last committed value is what separates
 *    "commit on blur" from "commit twice when Enter also blurs".
 */

export interface FieldOptions {
  label?: string;
  /** Small text under the control. Replaced by `error` when one is set. */
  hint?: string;
  className?: string;
}

export interface TextInputOptions extends FieldOptions {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'url' | 'date' | 'email' | 'password';
  multiline?: boolean;
  /** Select the whole value when it receives focus. */
  selectOnFocus?: boolean;
  /** Enter, or blur. Return a string to reject the value and show it as an error. */
  onCommit?: (value: string) => string | void;
  /** Every keystroke. For live filtering. */
  onInput?: (value: string) => void;
  /** Escape, or a rejected commit that the user then abandoned. */
  onCancel?: () => void;
}

export interface Control<T extends HTMLElement = HTMLElement> {
  /** The wrapper: label + control + hint/error. Append this. */
  el: HTMLElement;
  /** The control itself, for focus and direct reads. */
  input: T;
  value(): string;
  setValue(next: string): void;
  focus(): void;
  /** Show a validation message under the control; `null` clears it. */
  setError(message: string | null): void;
}

function wrapper(opts: FieldOptions, control: HTMLElement): { el: HTMLElement; setError: (m: string | null) => void } {
  const el = document.createElement('div');
  el.className = 'nbe-field' + (opts.className ? ` ${opts.className}` : '');
  if (opts.label) {
    const label = document.createElement('label');
    label.className = 'nbe-field-label';
    label.textContent = opts.label;
    // wrapping associates the label without needing to mint ids
    label.append(control);
    el.append(label);
  } else {
    el.append(control);
  }
  const note = document.createElement('div');
  note.className = 'nbe-field-hint';
  if (opts.hint) note.textContent = opts.hint;
  if (opts.hint) el.append(note);

  const setError = (message: string | null) => {
    el.classList.toggle('nbe-field-invalid', message !== null);
    control.setAttribute('aria-invalid', message !== null ? 'true' : 'false');
    note.textContent = message ?? opts.hint ?? '';
    note.className = message ? 'nbe-field-hint nbe-field-error' : 'nbe-field-hint';
    if (note.textContent && !note.isConnected) el.append(note);
  };
  return { el, setError };
}

/** Shared key discipline: Enter commits, Escape reverts, nothing escapes. */
function bindKeys(
  input: HTMLInputElement | HTMLTextAreaElement,
  opts: { multiline?: boolean; commit: () => void; cancel: () => void },
): void {
  input.setAttribute(ESCAPE_SELF_ATTR, '');
  input.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    // a field inside the editor must not feed the keymap
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.cancel();
    } else if (e.key === 'Enter' && !opts.multiline) {
      e.preventDefault();
      opts.commit();
    }
  });
}

export function createTextInput(opts: TextInputOptions = {}): Control<HTMLInputElement | HTMLTextAreaElement> {
  const input = document.createElement(opts.multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
  input.className = 'nbe-input';
  if (!opts.multiline) (input as HTMLInputElement).type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  const initial = opts.value ?? '';
  input.value = initial;

  const { el, setError } = wrapper(opts, input);
  // the committed value is the latch: Enter then blur, or a blur that follows
  // a revert, both see no change and do nothing
  let committed = initial;

  const commit = () => {
    const next = input.value;
    if (next === committed) return;
    const rejection = opts.onCommit?.(next);
    if (typeof rejection === 'string') {
      setError(rejection);
      return;
    }
    setError(null);
    committed = next;
  };
  const cancel = () => {
    input.value = committed;
    setError(null);
    opts.onCancel?.();
    // blur after reverting, so the blur-commit sees no change and does nothing
    input.blur();
  };

  bindKeys(input, { multiline: opts.multiline, commit, cancel });
  input.addEventListener('blur', commit);
  if (opts.onInput) input.addEventListener('input', () => opts.onInput!(input.value));
  if (opts.selectOnFocus) {
    input.addEventListener('focus', () => (input as HTMLInputElement).select?.());
  }

  return {
    el,
    input,
    value: () => input.value,
    setValue: (next) => {
      input.value = next;
      committed = next;
    },
    focus: () => input.focus(),
    setError,
  };
}

export interface SelectOptions extends FieldOptions {
  options: Array<{ value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
}

export function createSelect(opts: SelectOptions): Control<HTMLSelectElement> {
  const select = document.createElement('select');
  select.className = 'nbe-select';
  for (const o of opts.options) {
    const option = document.createElement('option');
    option.value = o.value;
    option.textContent = o.label;
    select.append(option);
  }
  if (opts.value !== undefined) select.value = opts.value;
  select.setAttribute(ESCAPE_SELF_ATTR, '');
  select.addEventListener('keydown', (e) => e.stopPropagation());
  if (opts.onChange) select.addEventListener('change', () => opts.onChange!(select.value));

  const { el, setError } = wrapper(opts, select);
  return {
    el,
    input: select,
    value: () => select.value,
    setValue: (next) => (select.value = next),
    focus: () => select.focus(),
    setError,
  };
}

export interface CheckboxOptions extends FieldOptions {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

export function createCheckbox(opts: CheckboxOptions = {}): Control<HTMLInputElement> {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'nbe-checkbox-input';
  input.checked = opts.checked === true;
  input.setAttribute(ESCAPE_SELF_ATTR, '');
  input.addEventListener('keydown', (e) => e.stopPropagation());
  if (opts.onChange) input.addEventListener('change', () => opts.onChange!(input.checked));

  // the label wraps the box and sits after it, unlike the other controls
  const el = document.createElement('label');
  el.className = 'nbe-field nbe-field-inline' + (opts.className ? ` ${opts.className}` : '');
  el.append(input);
  if (opts.label) {
    const text = document.createElement('span');
    text.className = 'nbe-field-label';
    text.textContent = opts.label;
    el.append(text);
  }

  return {
    el,
    input,
    value: () => String(input.checked),
    setValue: (next) => (input.checked = next === 'true'),
    focus: () => input.focus(),
    setError: () => {},
  };
}

export interface SegmentedOptions extends FieldOptions {
  options: Array<{ value: string; label: string; title?: string }>;
  value?: string;
  onChange?: (value: string) => void;
}

/**
 * A small set of mutually exclusive choices, shown at once. A select hides its
 * options behind a click; for two to four visual choices — text alignment, a
 * callout variant — showing them is both faster and self-documenting.
 */
export function createSegmented(opts: SegmentedOptions): Control<HTMLElement> {
  const group = document.createElement('div');
  group.className = 'nbe-segmented';
  group.setAttribute('role', 'radiogroup');
  let current = opts.value ?? opts.options[0]?.value ?? '';

  const buttons = opts.options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nbe-segmented-option';
    b.textContent = o.label;
    b.setAttribute('role', 'radio');
    if (o.title) b.title = o.title;
    b.addEventListener('click', () => {
      current = o.value;
      sync();
      opts.onChange?.(o.value);
    });
    group.append(b);
    return { b, value: o.value };
  });

  const sync = () => {
    for (const { b, value } of buttons) {
      const on = value === current;
      b.classList.toggle('nbe-active', on);
      b.setAttribute('aria-checked', String(on));
      // roving tabindex: the group is one tab stop, arrows move within it
      b.tabIndex = on ? 0 : -1;
    }
  };
  sync();

  group.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.findIndex((x) => x.value === current);
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]!;
    current = next.value;
    sync();
    next.b.focus();
    opts.onChange?.(next.value);
  });

  const { el, setError } = wrapper(opts, group);
  return {
    el,
    input: group,
    value: () => current,
    setValue: (next) => {
      current = next;
      sync();
    },
    focus: () => buttons.find((x) => x.value === current)?.b.focus(),
    setError,
  };
}

/**
 * Replace an element's content with a text field, commit on Enter or blur,
 * restore on Escape. The inline-edit pattern `database.ts` hand-rolled for
 * cells and titles.
 */
export function editInline(
  host: HTMLElement,
  initial: string,
  commit: (value: string) => void,
  opts: { type?: TextInputOptions['type']; multiline?: boolean } = {},
): Control<HTMLInputElement | HTMLTextAreaElement> {
  const restore = () => {
    host.textContent = initial;
  };
  const control = createTextInput({
    value: initial,
    type: opts.type,
    multiline: opts.multiline,
    selectOnFocus: true,
    onCommit: (v) => {
      commit(v);
    },
    onCancel: restore,
    className: 'nbe-field-bare',
  });
  host.replaceChildren(control.el);
  control.focus();
  return control;
}
