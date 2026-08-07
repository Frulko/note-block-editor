// @vitest-environment happy-dom
//
// The form primitives are plugin API surface: whatever @nbe/dom exports when
// the plugin contract freezes is what block authors depend on. These pin the
// three rules every control obeys — Escape is the control's, keys stay inside,
// and commit happens exactly once.
import { describe, expect, it, vi } from 'vitest';
import {
  createCheckbox,
  createSegmented,
  createSelect,
  createTextInput,
  editInline,
} from '../src/ui/field';

const key = (el: HTMLElement, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('text input — commit discipline', () => {
  it('commits on Enter', () => {
    const onCommit = vi.fn();
    const c = createTextInput({ value: 'a', onCommit });
    (c.input as HTMLInputElement).value = 'b';
    key(c.input, 'Enter');
    expect(onCommit).toHaveBeenCalledWith('b');
  });

  it('commits on blur', () => {
    const onCommit = vi.fn();
    const c = createTextInput({ value: 'a', onCommit });
    (c.input as HTMLInputElement).value = 'b';
    c.input.dispatchEvent(new Event('blur'));
    expect(onCommit).toHaveBeenCalledWith('b');
  });

  it('commits exactly once when Enter is followed by blur', () => {
    // the bug this latch exists for: Enter commits, the resulting blur commits
    // again, and the caller sees two writes for one edit
    const onCommit = vi.fn();
    const c = createTextInput({ value: 'a', onCommit });
    (c.input as HTMLInputElement).value = 'b';
    key(c.input, 'Enter');
    c.input.dispatchEvent(new Event('blur'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('does not commit an unchanged value', () => {
    const onCommit = vi.fn();
    const c = createTextInput({ value: 'a', onCommit });
    c.input.dispatchEvent(new Event('blur'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reverts on Escape and never commits', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const c = createTextInput({ value: 'a', onCommit, onCancel });
    (c.input as HTMLInputElement).value = 'b';
    key(c.input, 'Escape');
    expect(c.value()).toBe('a');
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps the field open and shows the message when a commit is rejected', () => {
    const c = createTextInput({ value: 'a', onCommit: () => 'déjà pris' });
    (c.input as HTMLInputElement).value = 'b';
    key(c.input, 'Enter');
    expect(c.el.className).toContain('nbe-field-invalid');
    expect(c.el.textContent).toContain('déjà pris');
    expect(c.input.getAttribute('aria-invalid')).toBe('true');
  });

  it('retries a rejected value rather than swallowing it', () => {
    const onCommit = vi.fn((v: string) => (v === 'bad' ? 'non' : undefined));
    const c = createTextInput({ value: 'a', onCommit });
    (c.input as HTMLInputElement).value = 'bad';
    key(c.input, 'Enter');
    (c.input as HTMLInputElement).value = 'good';
    key(c.input, 'Enter');
    expect(onCommit).toHaveBeenLastCalledWith('good');
    expect(c.el.className).not.toContain('nbe-field-invalid');
  });
});

describe('keys stay inside the control', () => {
  it('stops keydown from reaching the editor keymap', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen = vi.fn();
    host.addEventListener('keydown', seen);
    const c = createTextInput();
    host.append(c.el);
    key(c.input, 'a');
    expect(seen).not.toHaveBeenCalled();
    host.remove();
  });

  it('marks itself so the overlay stack yields Escape to it', () => {
    for (const c of [createTextInput(), createSelect({ options: [] }), createCheckbox()]) {
      expect(c.input.hasAttribute('data-nbe-escape-self')).toBe(true);
    }
  });

  it('lets Enter through in a multiline field', () => {
    const onCommit = vi.fn();
    const c = createTextInput({ multiline: true, onCommit });
    (c.input as HTMLTextAreaElement).value = 'x';
    const e = key(c.input, 'Enter');
    expect(e.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('select', () => {
  it('renders its options and reports changes', () => {
    const onChange = vi.fn();
    const c = createSelect({
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      value: 'b',
      onChange,
    });
    expect(c.input.querySelectorAll('option')).toHaveLength(2);
    expect(c.value()).toBe('b');
    c.input.value = 'a';
    c.input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('a');
  });
});

describe('checkbox', () => {
  it('reports its state and carries its label', () => {
    const onChange = vi.fn();
    const c = createCheckbox({ label: 'Actif', checked: true, onChange });
    expect((c.input as HTMLInputElement).checked).toBe(true);
    expect(c.el.textContent).toContain('Actif');
    (c.input as HTMLInputElement).checked = false;
    c.input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('segmented', () => {
  const opts = [
    { value: 'left', label: '⇤' },
    { value: 'center', label: '↔' },
    { value: 'right', label: '⇥' },
  ];

  it('marks the current option and reports a click', () => {
    const onChange = vi.fn();
    const c = createSegmented({ options: opts, value: 'center', onChange });
    const buttons = [...c.input.querySelectorAll('button')];
    expect(buttons[1]!.getAttribute('aria-checked')).toBe('true');
    buttons[2]!.click();
    expect(onChange).toHaveBeenCalledWith('right');
    expect(c.value()).toBe('right');
  });

  it('is one tab stop, with arrows moving inside it', () => {
    const c = createSegmented({ options: opts, value: 'left' });
    const buttons = [...c.input.querySelectorAll('button')];
    // roving tabindex: exactly one reachable by Tab
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    key(c.input, 'ArrowRight');
    expect(c.value()).toBe('center');
    key(c.input, 'ArrowLeft');
    key(c.input, 'ArrowLeft');
    expect(c.value()).toBe('right'); // wraps
  });

  it('does not let its arrows reach the editor', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen = vi.fn();
    host.addEventListener('keydown', seen);
    const c = createSegmented({ options: opts });
    host.append(c.el);
    key(c.input, 'ArrowRight');
    expect(seen).not.toHaveBeenCalled();
    host.remove();
  });
});

describe('editInline', () => {
  it('replaces the host, commits on Enter', () => {
    const host = document.createElement('div');
    host.textContent = 'ancien';
    const commit = vi.fn();
    const c = editInline(host, 'ancien', commit);
    expect(host.querySelector('input')).not.toBeNull();
    (c.input as HTMLInputElement).value = 'nouveau';
    key(c.input, 'Enter');
    expect(commit).toHaveBeenCalledWith('nouveau');
  });

  it('restores the original text on Escape without committing', () => {
    const host = document.createElement('div');
    host.textContent = 'ancien';
    const commit = vi.fn();
    const c = editInline(host, 'ancien', commit);
    (c.input as HTMLInputElement).value = 'nouveau';
    key(c.input, 'Escape');
    expect(host.textContent).toBe('ancien');
    expect(commit).not.toHaveBeenCalled();
  });
});
