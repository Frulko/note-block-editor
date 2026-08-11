import { describe, expect, it } from 'vitest';
import { APP_SECTION, Frontmatter, readFrontmatter, writeFrontmatter } from '../packages/markdown/src/index';
import { templateText, templatesFor } from '../apps/obsidian/src/templates';
import { DEFAULT_SETTINGS, type CarnetSettings } from '../apps/obsidian/src/settings';

/**
 * A folder says what a new note in it may start from, and its subfolders
 * inherit that. Two halves are worth testing and neither touches Obsidian: the
 * walk up the folder chain, which has to end at the vault root and does not
 * end there by itself, and what a template's header turns into when the note
 * being made from it is not the template.
 */
const settings = (templates: Record<string, string[]>): CarnetSettings => ({
  ...DEFAULT_SETTINGS,
  templates,
});

describe('templatesFor', () => {
  it('offers the folder’s own templates', () => {
    const s = settings({ Projets: ['Modèles/Projet.md'] });
    expect(templatesFor(s, 'Projets')).toEqual(['Modèles/Projet.md']);
  });

  it('inherits from every parent, nearest first', () => {
    const s = settings({
      '': ['Modèles/Vide.md'],
      Projets: ['Modèles/Projet.md'],
      'Projets/2026': ['Modèles/Trimestre.md'],
    });
    expect(templatesFor(s, 'Projets/2026/Q3')).toEqual([
      'Modèles/Trimestre.md',
      'Modèles/Projet.md',
      'Modèles/Vide.md',
    ]);
  });

  it('terminates at the vault root, mapped or not', () => {
    // the root is its own parent under a naive walk, so this is the case that
    // hangs rather than the case that returns the wrong answer
    expect(templatesFor(settings({}), '')).toEqual([]);
    expect(templatesFor(settings({}), 'a/b/c')).toEqual([]);
  });

  it('proposes a template listed twice in the chain once', () => {
    const s = settings({ '': ['Modèles/Note.md'], Projets: ['Modèles/Note.md'] });
    expect(templatesFor(s, 'Projets')).toEqual(['Modèles/Note.md']);
  });

  it('does not leak between branches', () => {
    const s = settings({ Projets: ['Modèles/Projet.md'] });
    expect(templatesFor(s, 'Journal')).toEqual([]);
    // a sibling whose name merely starts the same way is not a child
    expect(templatesFor(s, 'Projets anciens')).toEqual([]);
  });
});

describe('templateText', () => {
  const template = () => {
    const fm = new Frontmatter();
    fm.set('title', 'Compte rendu de réunion');
    fm.set('tags', ['réunion']);
    fm.setSection('comments', [
      { id: 't1', blockId: 'b1', resolved: false, messages: [{ id: 'm1', author: 'a', body: 'à revoir', at: 1 }] },
    ]);
    return writeFrontmatter(fm, '## Présents\n\n## Décisions\n');
  };

  it('drops the template’s own title: the new note has a name of its own', () => {
    const { frontmatter } = readFrontmatter(templateText(template()));
    expect(frontmatter.has('title')).toBe(false);
  });

  it('drops the threads: a discussion belongs to the blocks it was left on', () => {
    const { frontmatter } = readFrontmatter(templateText(template()));
    expect(frontmatter.has(APP_SECTION)).toBe(false);
  });

  it('keeps everything else, header and body', () => {
    const out = templateText(template());
    const { frontmatter, body } = readFrontmatter(out);
    expect(frontmatter.get('tags')).toEqual(['réunion']);
    expect(body).toContain('## Décisions');
  });

  it('leaves a template with no header alone', () => {
    expect(templateText('# Titre\n\nDu texte.\n')).toBe('# Titre\n\nDu texte.\n');
  });
});
