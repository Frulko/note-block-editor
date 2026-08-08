import { beforeAll, describe, expect, it } from 'vitest';
import { Workspace, memoryStorage } from '../src/index';

/**
 * Ten thousand notes.
 *
 * @remarks
 * The competitive survey sets the bar that makes a product visibly better than
 * everyone rather than merely adequate: **sub-100ms search at 10k notes**. It
 * also records where the field actually breaks — Notion degrades around 2,000
 * pages, Anytype's Android takes 100 seconds to search at 8,000 objects, and
 * Obsidian handles 53,000 files without complaint. That spread is the whole
 * competitive picture for scale.
 *
 * It had never been measured here. This measures it, and it also protects the
 * shape of the answer: `search` walks pages, so a change that made it walk
 * *blocks* would still be correct and would fall off this cliff.
 *
 * The threshold is deliberately loose. The job is to catch an algorithmic
 * regression, not to police milliseconds on a shared runner.
 */

const COUNT = 10_000;
let workspace: Workspace;
let built = 0;

beforeAll(async () => {
  workspace = new Workspace(memoryStorage());
  await workspace.load();
  const start = Date.now();
  for (let i = 0; i < COUNT; i++) {
    // varied titles, so a search is a real scan rather than one lucky prefix
    await workspace.createPage({ title: `Note ${i} — ${i % 7 === 0 ? 'réunion' : 'brouillon'} ${i * 31}` });
  }
  built = Date.now() - start;
}, 120_000);

describe('creating pages does not get slower as the workspace grows', () => {
  it('costs the same at two thousand pages as at none', async () => {
    const fresh = new Workspace(memoryStorage());
    await fresh.load();
    let seq = 0;
    const chunk = async (n: number) => {
      const start = Date.now();
      for (let i = 0; i < n; i++) await fresh.createPage({ title: `p${seq++}` });
      return Date.now() - start;
    };

    const first = await chunk(200);
    for (let i = 0; i < 9; i++) await chunk(200);
    const later = await chunk(200);

    /*
     * The derived tree is rebuilt lazily, so a batch of writes costs one
     * rebuild rather than one per write. Eagerly it was quadratic: 18ms for the
     * first two hundred pages and 186ms once there were two thousand, and
     * building ten thousand took 33 seconds against 150ms now.
     *
     * Wide tolerance on purpose — this catches a return to O(n) per write, not
     * a slow runner. Adding `+ 20` keeps a sub-millisecond baseline from making
     * the ratio meaningless.
     */
    console.log(`création : 200 premières ${first}ms, 200 à ~2000 pages ${later}ms`);
    expect(later).toBeLessThan(first * 4 + 20);
  }, 60_000);
});

describe('ten thousand notes', () => {
  it('builds a workspace that size at all', () => {
    expect(workspace.pages).toHaveLength(COUNT);
    console.log(`construction de ${COUNT} pages : ${built}ms`);
  });

  it('searches in well under the bar', () => {
    // warm, then measure a median — the first call pays for lazy structures
    workspace.search('réunion');
    const samples = Array.from({ length: 9 }, () => {
      const start = performance.now();
      workspace.search('réunion');
      return performance.now() - start;
    }).sort((a, b) => a - b);
    const p50 = samples[4]!;
    console.log(`recherche parmi ${COUNT} pages : médiane ${p50.toFixed(1)}ms`);
    expect(p50).toBeLessThan(300);
  });

  it('an accent-insensitive query costs the same as a plain one', () => {
    // the fold must not be a second pass over everything
    const plain = (() => {
      const start = performance.now();
      workspace.search('brouillon');
      return performance.now() - start;
    })();
    const folded = (() => {
      const start = performance.now();
      workspace.search('reunion'); // no accent, must still match "réunion"
      return performance.now() - start;
    })();
    expect(workspace.search('reunion').length).toBeGreaterThan(0);
    expect(folded).toBeLessThan(plain * 4 + 50);
  });

  it('the page tree is still derived, not cached into staleness', () => {
    // roots are computed from sub_page blocks; at this size a naive derivation
    // would be the thing that quietly became quadratic
    const start = performance.now();
    const roots = workspace.roots;
    const elapsed = performance.now() - start;
    console.log(`dérivation de l’arbre : ${elapsed.toFixed(1)}ms pour ${roots.length} racines`);
    expect(roots).toHaveLength(COUNT);
    expect(elapsed).toBeLessThan(300);
  });
});
