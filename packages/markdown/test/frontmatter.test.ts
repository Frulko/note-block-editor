import { describe, expect, it } from 'vitest';
import {
  APP_SECTION,
  Frontmatter,
  documentToMarkdown,
  markdownToDocument,
  readFrontmatter,
  slugify,
  writeFrontmatter,
} from '../src/index';

/**
 * The promise this file checks is not "we can write YAML" — it is that a note
 * someone else also writes into comes back out unharmed. A vault's own
 * properties are the ones most likely to be lost by an editor that thinks it
 * owns the header, and losing them is silent.
 */

const NOTE = `---
title: Journal
tags:
  - projet
  - 2026
# une note pour plus tard
aliases: ["J", "Jrnl"]
---

# Lundi

Du texte.
`;

describe('reading a file', () => {
  it('splits the header from the prose, and reads the values', () => {
    const { frontmatter, body } = readFrontmatter(NOTE);
    expect(frontmatter.get('title')).toBe('Journal');
    // `2026` unquoted is a number, here as in every other YAML reader
    expect(frontmatter.get('tags')).toEqual(['projet', 2026]);
    expect(frontmatter.get('aliases')).toEqual(['J', 'Jrnl']);
    expect(body).toBe('\n# Lundi\n\nDu texte.\n');
  });

  it('leaves a file with no header alone', () => {
    const text = '# Titre\n\n---\n\nune ligne de séparation\n';
    const { frontmatter, body } = readFrontmatter(text);
    expect(frontmatter.empty).toBe(true);
    expect(body).toBe(text);
    expect(writeFrontmatter(frontmatter, body)).toBe(text);
  });

  it('gives nothing back for a key the file does not carry', () => {
    expect(readFrontmatter(NOTE).frontmatter.get('nonexistent')).toBeUndefined();
  });
});

describe('writing it back', () => {
  it('is byte-exact when nothing was touched', () => {
    const { frontmatter, body } = readFrontmatter(NOTE);
    expect(writeFrontmatter(frontmatter, body)).toBe(NOTE);
  });

  it('keeps every key it did not touch verbatim, comment included', () => {
    const { frontmatter, body } = readFrontmatter(NOTE);
    frontmatter.set('title', 'Réunion : 2026/07');
    const out = writeFrontmatter(frontmatter, body);
    expect(out).toContain('title: "Réunion : 2026/07"');
    expect(out).toContain('tags:\n  - projet\n  - 2026');
    expect(out).toContain('# une note pour plus tard');
    expect(out).toContain('aliases: ["J", "Jrnl"]');
    // and reading it back gives the title, not the quotes
    expect(readFrontmatter(out).frontmatter.get('title')).toBe('Réunion : 2026/07');
  });

  it('appends a new key at the end rather than in the middle of someone else header', () => {
    const { frontmatter, body } = readFrontmatter(NOTE);
    frontmatter.set('id', 'abc');
    expect(writeFrontmatter(frontmatter, body)).toContain('aliases: ["J", "Jrnl"]\nid: abc\n---\n');
  });

  it('removes a key with undefined, and the fence with the last of them', () => {
    const fm = new Frontmatter().set('title', 'x');
    expect(fm.toString()).toBe('---\ntitle: x\n---\n');
    fm.set('title', undefined);
    expect(fm.toString()).toBe('');
    expect(writeFrontmatter(fm, 'du texte\n')).toBe('du texte\n');
  });

  it('writes the header tight against the prose, the way a vault does', () => {
    expect(writeFrontmatter(new Frontmatter().set('id', 'x'), 'texte\n')).toBe('---\nid: x\n---\ntexte\n');
  });

  it('quotes anything that would read back as something else', () => {
    const fm = new Frontmatter()
      .set('numérique', '42')
      .set('booléen', 'true')
      .set('deux points', 'a: b')
      .set('nombre', 42)
      .set('coché', true)
      .set('simple', 'Journal 2026');
    const back = readFrontmatter(fm.toString() + 'x').frontmatter;
    expect(back.get('numérique')).toBe('42');
    expect(back.get('booléen')).toBe('true');
    expect(back.get('deux points')).toBe('a: b');
    expect(back.get('nombre')).toBe(42);
    expect(back.get('coché')).toBe(true);
    expect(fm.toString()).toContain('simple: Journal 2026');
  });
});

describe('the editor own corner of the header', () => {
  it('keeps two sections side by side, and takes the key away with the last one', () => {
    const fm = new Frontmatter();
    fm.setSection('comments', [{ id: 't1', messages: [] }]);
    fm.setSection('un-greffon', { compteur: 3 });

    const back = readFrontmatter(fm.toString() + 'texte').frontmatter;
    expect(back.section<{ id: string }[]>('comments')![0]!.id).toBe('t1');
    expect(back.section<{ compteur: number }>('un-greffon')!.compteur).toBe(3);

    back.setSection('comments', undefined);
    expect(back.section('un-greffon')).toBeTruthy();
    back.setSection('un-greffon', undefined);
    expect(back.has(APP_SECTION)).toBe(false);
  });

  it('is one key, so a note own properties can never collide with ours', () => {
    const fm = new Frontmatter().set('comments', 'les miens');
    fm.setSection('comments', ['les nôtres']);
    expect(fm.get('comments')).toBe('les miens');
    expect(fm.section('comments')).toEqual(['les nôtres']);
  });
});

describe('a document: the header and the blocks together', () => {
  it('round-trips both halves', () => {
    const doc = markdownToDocument(NOTE);
    expect(doc.blocks[0]!.type).toBe('heading');
    expect(documentToMarkdown(doc)).toBe(NOTE.replace(/\n$/, ''));
  });

  it('holds the title a filename cannot, which is the point of the header', () => {
    const title = 'Réunion : 2026/07';
    const doc = markdownToDocument('du texte\n');
    doc.frontmatter.set('title', title);
    const file = documentToMarkdown(doc);

    // the file is named with what a filesystem accepts…
    expect(slugify(title)).toBe('Réunion 2026 07');
    // …and the note still knows what it is called
    expect(markdownToDocument(file).frontmatter.get('title')).toBe(title);
  });
});
