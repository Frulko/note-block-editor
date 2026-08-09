// @vitest-environment happy-dom
//
// Five languages, one shape. A dictionary that has drifted is not a
// translation problem, it is a blank space on someone's screen — so the
// completeness is checked rather than trusted, and so is the one thing a
// translator can silently break: a placeholder that no longer matches.
import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_NAMES, labelsFor, en, fr } from '../src/i18n';
import { defaultLabels } from '../src/labels';

const CODES = Object.keys(LOCALES) as Array<keyof typeof LOCALES>;

describe('every language is complete', () => {
  it.each(CODES)('%s has exactly the keys English has', (code) => {
    expect(Object.keys(LOCALES[code]).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(CODES)('%s has every placeholder English has', (code) => {
    expect(Object.keys(LOCALES[code].placeholders).sort()).toEqual(Object.keys(en.placeholders).sort());
  });

  it.each(CODES)('%s leaves no value empty', (code) => {
    const blank = Object.entries(LOCALES[code]).filter(([, v]) => typeof v === 'string' && !v.trim());
    expect(blank).toEqual([]);
  });

  it.each(CODES)('%s keeps the substitutions English uses', (code) => {
    // `{n}` in one language and `{count}` in another is a label that renders
    // the placeholder verbatim to a reader — and only to that reader
    const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== 'string') continue;
      const mine = LOCALES[code][key as keyof typeof en];
      expect(slots(mine as string), `${code}.${key}`).toEqual(slots(value));
    }
  });

  it('names each language in itself, so a picker is readable to whoever needs it', () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual(CODES.sort());
    expect(LOCALE_NAMES.de).toBe('Deutsch');
  });
});

describe('choosing one', () => {
  it('English is what an editor uses when a host names nothing', () => {
    expect(defaultLabels).toBe(en);
    expect(defaultLabels.bold).toBe('Bold');
  });

  it('takes a full BCP-47 tag, because a host reads a system setting', () => {
    expect(labelsFor('fr')).toBe(fr);
    expect(labelsFor('fr-CA')).toBe(fr);
    expect(labelsFor('de_AT')).toBe(LOCALES.de);
  });

  it('falls back to English rather than to nothing', () => {
    expect(labelsFor('jp')).toBe(en);
    expect(labelsFor('')).toBe(en);
  });
});
