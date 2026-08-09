import { describe, expect, it } from 'vitest';
import type { BlockJSON } from '@nbe/core';
import { PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { accepts, dropFiles, dropKind, dropZoneBlocks } from '../src/index';

/**
 * The whole design decision is in the Markdown, so that is what is tested.
 *
 * A zone could have been a container of `file` blocks; it is one block holding
 * a list because a container's boundaries have nowhere to live in Markdown,
 * while a bulleted list of links is something Markdown already spells — and
 * spells in a way every other tool renders. So the two things that matter are
 * that the round trip is exact, and that a file opened anywhere else shows
 * working links.
 */

const plugins = new PluginRegistry().registerAll(dropZoneBlocks);

const zone = (props: Record<string, unknown>): BlockJSON => ({
  id: 'z',
  type: 'drop_zone',
  version: 1,
  props,
});

const FILES = [
  { name: 'rapport.pdf', src: 'attachments/rapport.pdf', size: 182734, mime: 'application/pdf' },
  { name: 'notes.pdf', src: 'attachments/notes.pdf' },
];

describe('a zone in Markdown', () => {
  it('is a bulleted list of links between two markers', () => {
    const md = blocksToMarkdown([zone({ kind: 'pdf', files: FILES })], { plugins });
    expect(md.split('\n')).toEqual([
      '<!-- nbe:drop_zone {"kind":"pdf"} -->',
      '- [rapport.pdf](attachments/rapport.pdf) <!-- nbe:file {"props":{"size":182734,"mime":"application/pdf"}} -->',
      '- [notes.pdf](attachments/notes.pdf)',
      '<!-- /nbe:drop_zone -->',
    ]);
  });

  it('comes back as itself, with everything it carried', () => {
    const md = blocksToMarkdown([zone({ kind: 'pdf', files: FILES })], { plugins });
    const [back] = markdownToBlocks(md, { plugins });
    expect(back?.type).toBe('drop_zone');
    expect(dropKind(back?.props)).toBe('pdf');
    expect(dropFiles(back?.props)).toEqual(FILES);
  });

  it('round-trips byte for byte', () => {
    const md = blocksToMarkdown([zone({ kind: 'image', files: FILES })], { plugins });
    expect(blocksToMarkdown(markdownToBlocks(md, { plugins }), { plugins })).toBe(md);
  });

  it('survives a hand-edited link with no trailer at all', () => {
    const md = ['<!-- nbe:drop_zone {} -->', '- [ajouté à la main](fichiers/x.png)', '<!-- /nbe:drop_zone -->'].join('\n');
    const [back] = markdownToBlocks(md, { plugins });
    expect(dropFiles(back?.props)).toEqual([{ name: 'ajouté à la main', src: 'fichiers/x.png' }]);
  });

  it('does not let an unclosed zone eat the rest of the note', () => {
    // a truncated file is how one bad line turns into a lost document. The
    // rule declines, the generic marker path keeps the block, and everything
    // after it is still there as itself
    const md = ['<!-- nbe:drop_zone {} -->', '- [fichier](y)', '', 'du texte après'].join('\n');
    const blocks = markdownToBlocks(md, { plugins });
    expect(blocks.map((b) => b.type)).toEqual(['drop_zone', 'bulleted_list_item', 'paragraph']);
    expect(blocksToMarkdown(blocks, { plugins })).toContain('du texte après');
  });
});

describe('what a zone will take', () => {
  it('takes anything when it is set to all', () => {
    expect(accepts('all', { type: 'application/zip', name: 'a.zip' })).toBe(true);
  });

  it('matches a PDF by type or by name', () => {
    expect(accepts('pdf', { type: 'application/pdf', name: 'sans-extension' })).toBe(true);
    expect(accepts('pdf', { type: '', name: 'RAPPORT.PDF' })).toBe(true);
    expect(accepts('pdf', { type: 'image/png', name: 'a.png' })).toBe(false);
  });

  it('falls back to the extension for a file the browser typed as nothing', () => {
    // measured on .mkv, and on anything arriving from a network share
    expect(accepts('video', { type: '', name: 'film.mkv' })).toBe(true);
    expect(accepts('image', { type: '', name: 'photo.heic' })).toBe(true);
    expect(accepts('image', { type: '', name: 'notes.txt' })).toBe(false);
  });

  it('reads an unknown kind as all, because refusing everything is worse', () => {
    expect(dropKind({ kind: 'spreadsheets' })).toBe('all');
  });
});
