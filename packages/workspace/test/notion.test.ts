import { describe, expect, it } from 'vitest';
import { plainText, type BlockJSON } from '@nbe/core';
import { SUB_PAGE, Workspace, memoryStorage } from '../src/index';
import { importNotion } from '../src/notion';

/**
 * Reading a Notion export.
 *
 * The fixtures below are constructed from the export shape documented in
 * `docs/research/notion-editor.md` — UUID-suffixed filenames, the title
 * repeated as a heading, relative links, emoji blockquotes for callouts, CSV
 * databases. They are not captured from a real export, which needs an account
 * this project does not have. So these prove the *parsing*; the shape is
 * second-hand, and `docs/TESTING.md` says so.
 */

const HEX_A = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const HEX_B = '11112222333344445555666666666666';
const file = (path: string, text: string) => ({ path, text });

/** Load imported pages into a workspace, so the tree can be inspected. */
async function workspaceOf(pages: BlockJSON[]): Promise<Workspace> {
  const ws = new Workspace(memoryStorage(Object.fromEntries(pages.map((p) => [p.id, p]))));
  await ws.load();
  return ws;
}

describe('page identity survives the import', () => {
  it('takes the id from the filename, hyphenated like ours', () => {
    const [page] = importNotion([file(`Mon projet ${HEX_A}.md`, '# Mon projet\n\ndu texte')]).pages;
    expect(page!.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(page!.props!['title']).toBe('Mon projet');
  });

  it('re-importing the same export lands on the same pages', () => {
    const files = [file(`Mon projet ${HEX_A}.md`, '# Mon projet\n\ndu texte')];
    expect(importNotion(files).pages[0]!.id).toBe(importNotion(files).pages[0]!.id);
  });

  it('a file with no Notion id still imports, with one of ours', () => {
    const [page] = importNotion([file('Notes.md', 'du texte')]).pages;
    expect(page!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page!.props!['title']).toBe('Notes');
  });
});

describe('the body is cleaned up on the way in', () => {
  it('keeps the title heading, which is how our own pages are built too', () => {
    // stripping it looked like removing a duplicate and actually removed the
    // title: a page is named after its first line of content
    const [page] = importNotion([file(`Mon projet ${HEX_A}.md`, '# Mon projet\n\nLe contenu.')]).pages;
    const texts = (page!.children ?? []).map((b) => plainText(b.text));
    expect(texts[0]).toBe('Mon projet');
    expect(texts).toContain('Le contenu.');
  });

  it('the imported page is named after its heading, not its first paragraph', async () => {
    const ws = await workspaceOf(importNotion([file(`Mon projet ${HEX_A}.md`, '# Mon projet\n\nLe contenu.')]).pages);
    expect(ws.pages[0]!.title).toBe('Mon projet');
  });

  it('reads an emoji blockquote back as a callout', () => {
    const [page] = importNotion([file(`P ${HEX_A}.md`, '> 💡 Attention à ceci')]).pages;
    const callout = (page!.children ?? []).find((b) => b.type === 'callout');
    expect(callout).toBeDefined();
    expect(callout!.props!['icon']).toBe('💡');
    expect(plainText(callout!.text)).toBe('Attention à ceci');
  });

  it('leaves an ordinary blockquote alone', () => {
    const [page] = importNotion([file(`P ${HEX_A}.md`, '> Une citation normale')]).pages;
    expect((page!.children ?? []).find((b) => b.type === 'quote')).toBeDefined();
  });
});

describe('the tree and the links are rebuilt', () => {
  const parent = file(`Parent ${HEX_A}.md`, `# Parent\n\n[Enfant](Parent%20${HEX_A}/Enfant%20${HEX_B}.md)`);
  const child = file(`Parent ${HEX_A}/Enfant ${HEX_B}.md`, '# Enfant\n\ndu texte');

  it('a page in a folder becomes a sub-page of the page that owns it', async () => {
    const ws = await workspaceOf(importNotion([parent, child]).pages);
    const parentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(ws.roots).toEqual([parentId]);
    expect(ws.node(parentId)!.children).toEqual(['11112222-3333-4444-5555-666666666666']);
  });

  it('a relative link becomes a mention of the page it names', () => {
    const [page] = importNotion([parent, child]).pages;
    const marks = (page!.children ?? []).flatMap((b) => (b.text ?? []).flatMap((r) => r.marks ?? []));
    const mention = marks.find((m) => m.type === 'mention');
    expect(mention?.attrs?.['pageId']).toBe('11112222-3333-4444-5555-666666666666');
  });

  it('leaves an external link as a link', () => {
    const [page] = importNotion([file(`P ${HEX_A}.md`, '[site](https://example.com)')]).pages;
    const marks = (page!.children ?? []).flatMap((b) => (b.text ?? []).flatMap((r) => r.marks ?? []));
    expect(marks.map((m) => m.type)).toEqual(['link']);
  });

  it('does not reference the child twice when the body already links to it', () => {
    const [page] = importNotion([parent, child]).pages;
    const refs = (page!.children ?? []).filter((b) => b.type === SUB_PAGE);
    expect(refs.length).toBeLessThanOrEqual(1);
  });

  it('nests a child the body never links to, which Notion does allow', async () => {
    const silent = file(`Parent ${HEX_A}.md`, '# Parent\n\nAucun lien ici.');
    const ws = await workspaceOf(importNotion([silent, child]).pages);
    expect(ws.node('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')!.children).toHaveLength(1);
  });
});

describe('a database CSV comes in as a collection, not a table', () => {
  const page = file(`Base ${HEX_A}.md`, '# Base\n\ndu texte');
  const csv = file(
    `Base ${HEX_A}/Table ${HEX_B}.csv`,
    'Nom,Statut\nAlice,"En cours, presque"\nBob,Fini',
  );

  it('yields a schema, a view and rows kept apart (§2.5)', () => {
    const { collections } = importNotion([page, csv]);
    expect(collections).toHaveLength(1);
    const [collection] = collections;
    expect(collection!.schema.properties.map((p) => p.name)).toEqual(['Statut']);
    expect(collection!.view.layout).toBe('table');
    expect(collection!.rows).toHaveLength(2);
  });

  it('the owning page holds a view block, not the data', () => {
    const { pages, collections } = importNotion([page, csv]);
    const owner = pages.find((p) => p.id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')!;
    const view = (owner.children ?? []).find((b) => b.type === 'database');
    expect(view!.props!['collectionId']).toBe(collections[0]!.schema.id);
    expect((owner.children ?? []).some((b) => b.type === 'table')).toBe(false);
  });

  it('rows are pages, so they show up in the workspace like any other', async () => {
    const { pages } = importNotion([page, csv]);
    const ws = await workspaceOf(pages);
    expect(ws.pages.map((p) => p.title)).toContain('Alice');
  });

  it('honours quoted fields with commas inside them', () => {
    const { collections } = importNotion([page, csv]);
    const property = collections[0]!.schema.properties[0]!;
    expect(collections[0]!.rows[0]!.props!['properties']).toEqual({ [property.id]: 'En cours, presque' });
  });

  it('the CSV is not a page of its own', () => {
    const { pages } = importNotion([page, csv]);
    // one markdown page plus one page per row, and nothing for the file itself
    expect(pages.filter((p) => p.props?.['collectionId'] === undefined)).toHaveLength(1);
  });
});
