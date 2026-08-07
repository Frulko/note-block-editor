import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoroBlockStore } from '../src/store';
import { connect, loopback } from '../src/sync';

/**
 * A document written by Swift, read by TypeScript.
 *
 * @remarks
 * The other direction is checked in `native/swift` (`SyncInteropTests`). Having
 * both means the format is agreed by two implementations rather than asserted
 * twice by one — if either side quietly changed how a block is laid out, one of
 * these two suites fails.
 *
 * The fixture is produced by `swift test`. It is committed, so this suite does
 * not need a Swift toolchain; the file being stale would show as a mismatch
 * with what the Swift tests assert, which is the failure we want.
 */

const FIXTURE = join(__dirname, '..', '..', '..', 'native', 'swift', 'Tests', 'NbeModelTests', 'from-swift.loro');

const texts = (store: LoroBlockStore): string[] =>
  [...store.values()]
    .filter((block) => block.type === 'paragraph')
    .map((block) => (block.text ?? []).map((run) => run.text).join(''))
    .sort();

describe('Swift is a peer, not a viewer', () => {
  it('a document written in Swift opens here, with its text intact', () => {
    expect(existsSync(FIXTURE), 'run `swift test` in native/swift to produce it').toBe(true);
    const store = new LoroBlockStore();
    store.import(readFileSync(FIXTURE));

    // accented, because a byte-level disagreement surfaces there first
    expect(texts(store)).toEqual(['deuxième ligne', 'écrit par Swift']);
  });

  it('its blocks keep our types and our ids', () => {
    const store = new LoroBlockStore();
    store.import(readFileSync(FIXTURE));
    const blocks = [...store.values()];

    expect(new Set(blocks.map((block) => block.type))).toEqual(new Set(['page', 'paragraph']));
    expect(blocks.every((block) => /^01920000-/.test(block.id))).toBe(true);
    // the tree owns the structure, so the page must have found its children
    const page = blocks.find((block) => block.type === 'page')!;
    expect(page.children).toHaveLength(2);
  });

  it('and it merges with an edit made here, which is what being a peer means', async () => {
    const swift = new LoroBlockStore();
    swift.import(readFileSync(FIXTURE));

    // a second peer starts from the same document, as a joining client does
    const web = new LoroBlockStore();
    web.import(readFileSync(FIXTURE));

    const [left, right] = loopback();
    connect(swift, left);
    connect(web, right);

    const page = [...web.values()].find((block) => block.type === 'page')!;
    const id = '01920000-0000-7000-8000-0000000000ff';
    web.set(id, { id, type: 'paragraph', version: 1, props: {}, children: [], parentId: page.id, text: [{ text: 'et depuis le web' }] });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(texts(swift)).toContain('et depuis le web');
    expect(texts(swift)).toContain('écrit par Swift');
  });
});

describe('a keystroke typed in Swift', () => {
  const TYPED = join(__dirname, '..', '..', '..', 'native', 'swift', 'Tests', 'NbeModelTests', 'swift-typed.loro');

  it('arrives here as an edit, not as a replacement', () => {
    expect(existsSync(TYPED), 'run `swift test` in native/swift to produce it').toBe(true);
    const store = new LoroBlockStore();
    store.import(readFileSync(TYPED));

    /*
     * The text was "bonjour" and someone typed into the middle of it through
     * an NSTextView. What arrives is the merged text — and it arrives because
     * the Swift side wrote through `LoroText.update`, which diffs. Had it
     * replaced the container, this would still read correctly and would
     * conflict with any concurrent edit, so the value here is the *shape* of
     * what crossed, and the Swift suite asserts that directly.
     */
    expect(texts(store)).toEqual(['bonjour tapé dans Swift']);
  });

  it('and an edit made here merges into it', async () => {
    const swift = new LoroBlockStore();
    swift.import(readFileSync(TYPED));
    const web = new LoroBlockStore();
    web.import(readFileSync(TYPED));

    const [left, right] = loopback();
    connect(swift, left);
    connect(web, right);

    const paragraph = [...web.values()].find((block) => block.type === 'paragraph')!;
    web.set(paragraph.id, { ...paragraph, text: [{ text: 'bonjour tapé dans Swift, puis ici' }] });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(texts(swift)).toEqual(['bonjour tapé dans Swift, puis ici']);
  });
});
