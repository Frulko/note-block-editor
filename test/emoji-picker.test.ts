// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { openIconPicker } from '../packages/dom/src/ui/icon-picker';
import { mergeCatalogues, type EmojiGroup } from '../packages/emoji/src/index';
import { EMOJI_EN } from '../packages/emoji/src/en';
import { EMOJI_FR } from '../packages/emoji/src/fr';

/** What Carnet hands the picker: the reader's language, then English. */
const EMOJI_CATALOG: readonly EmojiGroup[] = mergeCatalogues(EMOJI_FR, EMOJI_EN);

/**
 * The emoji picker, over the generated catalogues.
 *
 * @remarks
 * What is worth holding here is the bilingual search: the whole point of
 * shipping CLDR's annotations rather than a hand-written list is that « fusée »
 * and "rocket" reach the same emoji, and that is exactly the property a
 * regenerated catalogue could silently lose — a generator that emitted one
 * language would still typecheck, still render, and only fail the reader.
 */

/** Open the picker over the full catalogue and hand back what is on screen. */
function open(): { search: HTMLInputElement; grid: HTMLElement; picked: string[]; close: () => void } {
  const picked: string[] = [];
  const controller = openIconPicker(() => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), {
    emojis: EMOJI_CATALOG,
    onPick: (icon) => picked.push(icon),
  });
  const root = document.querySelector('.nbe-iconpicker') as HTMLElement;
  return {
    search: root.querySelector('.nbe-iconpicker-search') as HTMLInputElement,
    grid: root.querySelector('.nbe-iconpicker-groups') as HTMLElement,
    picked,
    close: () => controller.close(),
  };
}

/** The emoji the grid is showing, in order. */
function shown(grid: HTMLElement): string[] {
  return [...grid.querySelectorAll('.nbe-iconpicker-emoji')].map((el) => el.textContent ?? '');
}

function type(picker: ReturnType<typeof open>, query: string): string[] {
  picker.search.value = query;
  picker.search.dispatchEvent(new Event('input'));
  return shown(picker.grid);
}

// a failing assertion skips the `close()` after it, and the next test would
// then query the *first* picker in the document — the stale one — and report a
// second failure that says nothing about itself
afterEach(() => document.querySelectorAll('.nbe-iconpicker').forEach((el) => el.remove()));

describe('the emoji picker over the full catalogue', () => {
  it('offers every emoji it was given', () => {
    const picker = open();
    expect(EMOJI_CATALOG.length).toBeGreaterThan(8);
    expect(shown(picker.grid).length).toBe(EMOJI_CATALOG.reduce((n, g) => n + g.items.length, 0));
    picker.close();
  });

  it('finds the same emoji in French and in English', () => {
    const picker = open();
    expect(type(picker, 'fusée')).toContain('🚀');
    expect(type(picker, 'rocket')).toContain('🚀');
    // and without the accent, which is how most people type in a hurry
    expect(type(picker, 'fusee')).toContain('🚀');
    picker.close();
  });

  it('falls back to letters-in-order when nothing matches outright', () => {
    const picker = open();
    // « confettis » with the vowels dropped, which is what typing fast does —
    // and it comes back first, not buried under the names that merely happen
    // to hold those five letters somewhere
    expect(type(picker, 'cnfti')[0]).toBe('🎊');
    picker.close();
  });

  it('does not let the loose rule outrank an exact one', () => {
    const picker = open();
    // 'chat' is a word: the cats come back, not every name holding c…h…a…t
    const cats = type(picker, 'chat');
    expect(cats).toContain('🐱');
    expect(cats.length).toBeLessThan(60);
    picker.close();
  });

  it('opens with the caret in the search field', () => {
    const picker = open();
    expect(document.activeElement).toBe(picker.search);
    picker.close();
  });

  it('accepts a pasted emoji as its own query', () => {
    const picker = open();
    expect(type(picker, '🐢')).toContain('🐢');
    picker.close();
  });

  it('says so rather than showing an empty grid', () => {
    const picker = open();
    expect(type(picker, 'zzzzz')).toEqual([]);
    expect(picker.grid.querySelector('.nbe-iconpicker-empty')).not.toBeNull();
    picker.close();
  });

  it('picks through one delegated listener, whatever the grid holds', () => {
    const picker = open();
    type(picker, 'rocket');
    const cell = picker.grid.querySelector('.nbe-iconpicker-emoji') as HTMLElement;
    cell.click();
    // whatever "rocket" ranked first — 🧑‍🚀 is one ZWJ sequence, and reading it
    // back off the cell is the part that would break if the handler guessed
    expect(picker.picked).toEqual([cell.textContent]);
    // picking closes it
    expect(document.querySelector('.nbe-iconpicker')).toBeNull();
  });
});
