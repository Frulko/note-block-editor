import { describe, expect, it } from 'vitest';
import { slugify } from '../src/index';

/**
 * A title is not a filename, and in a vault it has to be both.
 *
 * @remarks
 * `slugify` sits on two paths that both fail loudly when it is wrong: the
 * wikilink writer (`[[cible|titre]]`, where a `/` would point the link at
 * nothing) and the Obsidian plugin's inline title, where it is the rename
 * that goes to the filesystem. Renaming a note to « Daily 10/08 » used to
 * reach `vault.rename` verbatim and come back as
 * `ENOENT … Daily/Daily 10/08.md` — the slash read as a folder — which is a
 * filesystem error shown for something the reader did nothing wrong to cause.
 */
describe('a title reduced to what a filename can hold', () => {
  it('takes out the separators a path would read', () => {
    expect(slugify('Daily 10/08')).toBe('Daily 10 08');
    expect(slugify('C:\\notes')).toBe('C notes');
  });

  it('takes out the rest of what a vault refuses, and the wikilink syntax', () => {
    expect(slugify('Réunion : *2026* ?')).toBe('Réunion 2026');
    expect(slugify('a [b] | c # d ^ e')).toBe('a b c d e');
  });

  it('leaves a title that is already a name exactly as it was', () => {
    expect(slugify('Une note très bien nommée')).toBe('Une note très bien nommée');
  });

  it('always returns something a file can be called', () => {
    expect(slugify('   ')).toBe('sans-titre');
    expect(slugify('///')).toBe('sans-titre');
    expect(slugify('a'.repeat(200))).toHaveLength(60);
  });
});
