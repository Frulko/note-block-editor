import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type BlockJSON } from '@nbe/core';
import { SUB_PAGE, Workspace, memoryStorage, newPage, pageTitle, referencedAssets } from '../src/index';

/**
 * ROADMAP phase 4 — the notes app.
 *
 * The tree is *derived* from `sub_page` blocks in the parent's document, never
 * stored beside them (§10: the index holds zero unique information). Most of
 * what follows is that invariant, checked from different directions.
 */

let ws: Workspace;

const storage = () => memoryStorage();

beforeEach(async () => {
  ws = new Workspace(storage());
  await ws.load();
});

/** A page with some text in it, for search and backlink cases. */
function pageWith(title: string, blocks: BlockJSON[]): BlockJSON {
  const page = newPage(title);
  page.children = [...(page.children ?? []), ...blocks];
  return page;
}

const para = (text: string): BlockJSON => ({ id: uuidv7(), type: 'paragraph', version: 1, text: [{ text }] });

describe('an empty workspace', () => {
  it('has no pages and no roots', () => {
    expect(ws.roots).toEqual([]);
    expect(ws.pages).toEqual([]);
  });

  it('finds nothing, and does not crash looking', () => {
    expect(ws.search('quoi que ce soit')).toEqual([]);
    expect(ws.backlinks('absent')).toEqual([]);
    expect(ws.path('absent')).toEqual([]);
    expect(ws.document('absent')).toBeNull();
  });
});

describe('creating pages builds a tree', () => {
  it('a page with no parent is a root', async () => {
    const id = await ws.createPage({ title: 'Journal' });
    expect(ws.roots).toEqual([id]);
    expect(ws.node(id)!.parentId).toBeNull();
    expect(ws.node(id)!.title).toBe('Journal');
  });

  it('a page created under another is its child, and not a root', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Éditeur' });
    expect(ws.roots).toEqual([parent]);
    expect(ws.node(parent)!.children).toEqual([child]);
    expect(ws.node(child)!.parentId).toBe(parent);
  });

  it('nests to any depth, and the path reads as a breadcrumb', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    const c = await ws.createPage({ parentId: b, title: 'C' });
    expect(ws.path(c).map((n) => n.title)).toEqual(['A', 'B', 'C']);
  });

  it('keeps children in the order their references appear', async () => {
    const root = await ws.createPage({ title: 'Root' });
    const one = await ws.createPage({ parentId: root, title: 'Un' });
    const two = await ws.createPage({ parentId: root, title: 'Deux' });
    const zero = await ws.createPage({ parentId: root, title: 'Zero', index: 0 });
    expect(ws.node(root)!.children).toEqual([zero, one, two]);
  });
});

describe('the tree is derived, not stored', () => {
  it('the parent document carries a sub_page block naming the child', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Éditeur' });
    const refs = (ws.document(parent)!.children ?? []).filter((b) => b.type === SUB_PAGE);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.props!['pageId']).toBe(child);
  });

  it('a second Workspace over the same storage sees the same tree', async () => {
    const store = storage();
    const first = new Workspace(store);
    await first.load();
    const parent = await first.createPage({ title: 'Projets' });
    const child = await first.createPage({ parentId: parent, title: 'Éditeur' });

    // the whole point: nothing about the tree lives outside the documents
    const second = new Workspace(store);
    await second.load();
    expect(second.roots).toEqual([parent]);
    expect(second.node(parent)!.children).toEqual([child]);
  });

  it('a page nobody references stands as a root, so nothing is orphaned', async () => {
    const store = memoryStorage({ lost: { id: 'lost', type: 'page', version: 1, children: [para('perdu')] } });
    const w = new Workspace(store);
    await w.load();
    expect(w.roots).toEqual(['lost']);
  });

  it('a reference to a page that does not exist is ignored', async () => {
    const ghost: BlockJSON = {
      id: 'p',
      type: 'page',
      version: 1,
      children: [{ id: 'r', type: SUB_PAGE, version: 1, props: { pageId: 'nowhere' } }],
    };
    const w = new Workspace(memoryStorage({ p: ghost }));
    await w.load();
    expect(w.roots).toEqual(['p']);
    expect(w.node('p')!.children).toEqual([]);
  });
});

describe('a corrupt store still yields a forest', () => {
  const ref = (pageId: string): BlockJSON => ({ id: uuidv7(), type: SUB_PAGE, version: 1, props: { pageId } });
  const page = (id: string, children: BlockJSON[]): BlockJSON => ({ id, type: 'page', version: 1, children });

  it('a page claimed by two parents keeps its first claim', async () => {
    const w = new Workspace(
      memoryStorage({ a: page('a', [ref('c')]), b: page('b', [ref('c')]), c: page('c', []) }),
    );
    await w.load();
    const parents = w.pages.filter((n) => n.children.includes('c'));
    expect(parents).toHaveLength(1);
    expect(w.node('c')!.parentId).toBe(parents[0]!.id);
  });

  it('a cycle does not hang, and every page stays reachable', async () => {
    // a → b → a: both claimed, so a naive build would drop the pair entirely
    const w = new Workspace(memoryStorage({ a: page('a', [ref('b')]), b: page('b', [ref('a')]) }));
    await w.load();
    expect(w.roots.length).toBeGreaterThan(0);
    expect(w.pages).toHaveLength(2);
    expect(w.path('b').length).toBeLessThan(100);
  });

  it('a page cannot reference itself', async () => {
    const w = new Workspace(memoryStorage({ a: page('a', [ref('a')]) }));
    await w.load();
    expect(w.roots).toEqual(['a']);
    expect(w.node('a')!.children).toEqual([]);
  });
});

describe('moving pages', () => {
  it('reparents, and both sides agree afterwards', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ title: 'B' });
    const child = await ws.createPage({ parentId: a, title: 'Enfant' });
    expect(await ws.movePage(child, b)).toBe(true);
    expect(ws.node(a)!.children).toEqual([]);
    expect(ws.node(b)!.children).toEqual([child]);
    expect(ws.node(child)!.parentId).toBe(b);
  });

  it('promotes a page to a root', async () => {
    const a = await ws.createPage({ title: 'A' });
    const child = await ws.createPage({ parentId: a, title: 'Enfant' });
    expect(await ws.movePage(child, null)).toBe(true);
    expect(ws.roots).toContain(child);
    expect(ws.node(a)!.children).toEqual([]);
  });

  it('refuses to move a page into its own subtree', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    const c = await ws.createPage({ parentId: b, title: 'C' });
    // this would detach A, B and C from every root at once
    expect(await ws.movePage(a, c)).toBe(false);
    expect(ws.roots).toContain(a);
    expect(ws.path(c).map((n) => n.title)).toEqual(['A', 'B', 'C']);
  });

  it('refuses to move a page into itself', async () => {
    const a = await ws.createPage({ title: 'A' });
    expect(await ws.movePage(a, a)).toBe(false);
  });

  it('survives a reload, because the move rewrote the documents', async () => {
    const store = storage();
    const w = new Workspace(store);
    await w.load();
    const a = await w.createPage({ title: 'A' });
    const b = await w.createPage({ title: 'B' });
    const child = await w.createPage({ parentId: a, title: 'Enfant' });
    await w.movePage(child, b);

    const again = new Workspace(store);
    await again.load();
    expect(again.node(b)!.children).toEqual([child]);
  });
});

describe('renaming', () => {
  it('changes the title everywhere it is shown', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Ancien' });
    await ws.renamePage(child, 'Nouveau');
    expect(ws.node(child)!.title).toBe('Nouveau');
    const ref = (ws.document(parent)!.children ?? []).find((b) => b.type === SUB_PAGE);
    expect(ref!.props!['title']).toBe('Nouveau');
  });

  it('the title still comes from the document, not from the reference', async () => {
    const parent = await ws.createPage({ title: 'Projets' });
    const child = await ws.createPage({ parentId: parent, title: 'Titre' });
    // edit the page's own heading, leaving the cached reference title stale
    const doc = ws.document(child)!;
    doc.children![0]!.text = [{ text: 'Édité dans la page' }];
    await ws.save(child, doc);
    expect(ws.node(child)!.title).toBe('Édité dans la page');
  });
});

describe('deleting', () => {
  it('takes the whole subtree, deepest first', async () => {
    const a = await ws.createPage({ title: 'A' });
    const b = await ws.createPage({ parentId: a, title: 'B' });
    const c = await ws.createPage({ parentId: b, title: 'C' });
    expect(await ws.deletePage(a)).toEqual([c, b, a]);
    expect(ws.pages).toEqual([]);
  });

  it('leaves the rest of the workspace alone', async () => {
    const keep = await ws.createPage({ title: 'Garde' });
    const drop = await ws.createPage({ title: 'Jette' });
    await ws.deletePage(drop);
    expect(ws.roots).toEqual([keep]);
  });

  it('removes the parent reference too, so no dangling child appears', async () => {
    const parent = await ws.createPage({ title: 'Parent' });
    const child = await ws.createPage({ parentId: parent, title: 'Enfant' });
    await ws.deletePage(child);
    expect((ws.document(parent)!.children ?? []).some((b) => b.type === SUB_PAGE)).toBe(false);
    expect(ws.node(parent)!.children).toEqual([]);
  });
});

describe('search', () => {
  beforeEach(async () => {
    const store = memoryStorage({
      a: pageWith('Réunion', [para('Compte rendu de la réunion de lundi')]),
      b: pageWith('Recettes', [para('Tarte aux pommes et gâteau au chocolat')]),
    });
    ws = new Workspace(store);
    await ws.load();
  });

  it('finds a page by its text', () => {
    expect(ws.search('chocolat').map((h) => h.title)).toEqual(['Recettes']);
  });

  it('ignores case and accents, so "reunion" finds "réunion"', () => {
    expect(ws.search('REUNION').map((h) => h.title)).toEqual(['Réunion']);
    expect(ws.search('reunion')).toHaveLength(1);
  });

  it('returns a snippet with context around the match', () => {
    const [hit] = ws.search('lundi');
    expect(hit!.snippet).toContain('lundi');
    expect(hit!.snippet.length).toBeLessThan(120);
  });

  it('reports a page once, however many times it matches', () => {
    expect(ws.search('e').filter((h) => h.title === 'Recettes')).toHaveLength(1);
  });

  it('an empty query finds nothing rather than everything', () => {
    expect(ws.search('')).toEqual([]);
    expect(ws.search('   ')).toEqual([]);
  });
});

describe('backlinks', () => {
  it('finds a link-to-page, and says what kind it is', async () => {
    const target = await ws.createPage({ title: 'Cible' });
    const source = await ws.createPage({ title: 'Source' });
    const doc = ws.document(source)!;
    doc.children!.push({ id: uuidv7(), type: 'link_to_page', version: 1, props: { pageId: target } });
    await ws.save(source, doc);
    expect(ws.backlinks(target)).toEqual([{ pageId: source, title: 'Source', kind: 'link_to_page' }]);
  });

  it('finds an inline mention, which lives in a mark rather than a block', async () => {
    const target = await ws.createPage({ title: 'Cible' });
    const source = await ws.createPage({ title: 'Source' });
    const doc = ws.document(source)!;
    doc.children!.push({
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      text: [{ text: 'vois ' }, { text: 'Cible', marks: [{ type: 'mention', attrs: { pageId: target } }] }],
    });
    await ws.save(source, doc);
    expect(ws.backlinks(target).map((b) => b.kind)).toEqual(['mention']);
  });

  it('counts a sub-page as a backlink, distinctly from a mention', async () => {
    const parent = await ws.createPage({ title: 'Parent' });
    const child = await ws.createPage({ parentId: parent, title: 'Enfant' });
    expect(ws.backlinks(child)).toEqual([{ pageId: parent, title: 'Parent', kind: 'sub_page' }]);
  });

  it('never reports a page as its own backlink', async () => {
    const id = await ws.createPage({ title: 'Seule' });
    const doc = ws.document(id)!;
    doc.children!.push({ id: uuidv7(), type: 'link_to_page', version: 1, props: { pageId: id } });
    await ws.save(id, doc);
    expect(ws.backlinks(id)).toEqual([]);
  });
});

describe('titles', () => {
  it('come from the first non-empty text in the page', () => {
    expect(pageTitle(pageWith('', [para('Première ligne')]))).toBe('Première ligne');
  });

  it('fall back to the title prop, then to a placeholder', () => {
    expect(pageTitle({ id: 'x', type: 'page', version: 1, props: { title: 'Prop' } })).toBe('Prop');
    expect(pageTitle({ id: 'x', type: 'page', version: 1 })).toBe('Sans titre');
  });
});

describe('finding the assets a workspace still uses', () => {
  const withProps = (props: Record<string, unknown>): BlockJSON => ({
    id: uuidv7(),
    type: 'page',
    version: 1,
    children: [{ id: uuidv7(), type: 'image', version: 1, props }],
  });

  it('finds a reference in any prop, not just the ones we thought of', () => {
    expect(referencedAssets([withProps({ src: 'asset:abc' })])).toEqual(new Set(['asset:abc']));
    // a prop no block type uses today still counts, which is the point
    expect(referencedAssets([withProps({ poster: 'asset:xyz' })])).toEqual(new Set(['asset:xyz']));
  });

  it('looks inside nested props and arrays', () => {
    const page = withProps({ gallery: [{ src: 'asset:one' }, { src: 'asset:two' }] });
    expect(referencedAssets([page])).toEqual(new Set(['asset:one', 'asset:two']));
  });

  it('finds one in a mark attribute', () => {
    const page: BlockJSON = {
      id: uuidv7(),
      type: 'page',
      version: 1,
      children: [
        {
          id: uuidv7(),
          type: 'paragraph',
          version: 1,
          text: [{ text: 'voir', marks: [{ type: 'link', attrs: { href: 'asset:pdf' } }] }],
        },
      ],
    };
    expect(referencedAssets([page])).toEqual(new Set(['asset:pdf']));
  });

  it('descends into children', () => {
    const page: BlockJSON = {
      id: uuidv7(),
      type: 'page',
      version: 1,
      children: [
        { id: uuidv7(), type: 'toggle', version: 1, children: [{ id: uuidv7(), type: 'image', version: 1, props: { src: 'asset:deep' } }] },
      ],
    };
    expect(referencedAssets([page])).toEqual(new Set(['asset:deep']));
  });

  it('ignores ordinary URLs, which are not ours to collect', () => {
    expect(referencedAssets([withProps({ src: 'https://example.com/a.png' })]).size).toBe(0);
  });

  it('an empty workspace references nothing', () => {
    expect(referencedAssets([])).toEqual(new Set());
  });
});
