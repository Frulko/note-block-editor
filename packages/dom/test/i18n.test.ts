// @vitest-environment happy-dom
//
// i18n is only as good as the thing that stops it rotting. A dictionary that
// nothing consults is dead code, and a codebase that keeps growing hardcoded
// strings undoes the work one commit at a time — so the tripwire below scans
// the source, and it is the point of this file.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Editor, createDoc, docFromJSON } from '@nbe/core';
import { EditorView } from '../src/view';
import { defaultLabels, format, resolveLabels, type EditorLabels } from '../src/labels';

const SRC = join(import.meta.dirname, '..', 'src');

/** Every UI-facing module. Excluded files carry no on-screen strings. */
function uiSources(): string[] {
  const skip = new Set(['labels.ts', 'icons.ts', 'icon-picker.ts', 'database.ts']);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.ts') && !skip.has(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  return walk(SRC);
}

/** String and template literals, with comments stripped so prose is exempt. */
function literals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...code.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
}

const HAS_ACCENT = /[àâäéèêëîïôöûùüÿçœæÀÂÄÉÈÊËÎÏÔÖÛÙÜŸÇŒÆ]/;

describe('no on-screen string is hardcoded', () => {
  it.each(uiSources().map((f) => [f.slice(SRC.length + 1), f] as const))(
    '%s carries no accented literal',
    (_name, file) => {
      const offenders = literals(readFileSync(file, 'utf8')).filter((s) => HAS_ACCENT.test(s));
      // an accented literal in a UI module is a string that will show up in a
      // German app in French — put it in EditorLabels instead
      expect(offenders).toEqual([]);
    },
  );
});

describe('the dictionary is actually consulted', () => {
  it('renders the placeholder a host provided, not the shipped one', () => {
    const container = document.createElement('div');
    document.body.append(container);
    // createDoc() is an empty page with no children, so the document needs one
    const doc = docFromJSON({
      id: 'root',
      type: 'page',
      version: 1,
      children: [{ id: 'p', type: 'paragraph', version: 1 }],
    });
    const view = new EditorView(container, new Editor({ doc }), {
      labels: { emptyParagraph: 'Write something…' },
    });
    const leaf = view.content.querySelector<HTMLElement>('.nbe-leaf');
    expect(leaf?.dataset['placeholder']).toBe('Write something…');
    view.destroy();
    container.remove();
  });

  it('exposes the merged dictionary on the view', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const view = new EditorView(container, new Editor({ doc: createDoc() }), {
      labels: { duplicate: 'Duplicate' },
    });
    expect(view.labels.duplicate).toBe('Duplicate');
    expect(view.labels.delete).toBe(defaultLabels.delete);
    view.destroy();
    container.remove();
  });
});

describe('resolveLabels', () => {
  it('returns the defaults untouched when given nothing', () => {
    expect(resolveLabels()).toBe(defaultLabels);
  });

  it('never mutates the shipped defaults', () => {
    const before = defaultLabels.bold;
    resolveLabels({ bold: 'Bold' });
    expect(defaultLabels.bold).toBe(before);
  });

  it('covers every key, so a translator sees the whole surface', () => {
    const keys = Object.keys(defaultLabels) as Array<keyof EditorLabels>;
    expect(keys.length).toBeGreaterThan(60);
    const filled = (value: unknown): boolean =>
      typeof value === 'string'
        ? value.length > 0
        : // `placeholders` maps block type to text; every entry must be real too
          typeof value === 'object' && value !== null && Object.values(value).every(filled);
    expect(keys.every((k) => filled(defaultLabels[k]))).toBe(true);
  });

  it('translating one block placeholder keeps the others', () => {
    const labels = resolveLabels({ placeholders: { heading: 'Heading' } });
    expect(labels.placeholders.heading).toBe('Heading');
    expect(labels.placeholders.quote).toBe(defaultLabels.placeholders.quote);
  });
});

describe('format', () => {
  it('fills a named placeholder', () => {
    expect(format('Ligne {n}', { n: 2 })).toBe('Ligne 2');
  });

  it('leaves an unknown placeholder alone rather than emitting undefined', () => {
    expect(format('Ligne {n} de {total}', { n: 2 })).toBe('Ligne 2 de {total}');
  });

  it('works when a translation reorders or drops placeholders', () => {
    expect(format('Row {n}', { n: 3 })).toBe('Row 3');
    expect(format('Zeile', { n: 3 })).toBe('Zeile');
  });
});
