import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../packages/markdown/src/index';
import { CALLOUT_PRESETS, calloutPlugin } from '../packages/blocks-callout/src/index';
import { PluginRegistry } from '../packages/core/src/plugin';
import type { BlockJSON } from '../packages/core/src/doc';

/**
 * The reference plugin, which had no tests.
 *
 * @remarks
 * `@nbe/blocks-callout` exists to prove the extension API: it is the worked
 * example a third party copies, and the thing that fails first if the plugin
 * contract regresses. Four hundred lines of it, and the only coverage was
 * indirect — through vault round-trips that happen to contain a callout.
 *
 * That is backwards. A reference implementation should be the *most* tested
 * thing in a plugin system, because its failures are the ones that teach
 * everyone else the wrong lesson.
 *
 * It lives here rather than in the package because the projection has to be
 * exercised through `@nbe/markdown`, and `blocks-callout` deliberately depends
 * on `@nbe/core` alone — a thinness the packaging suite enforces. Adding the
 * dependency to reach the test would break the thing the test is checking.
 */

const callout = (variant: string, text: string, icon?: string): BlockJSON => ({
  id: 'c',
  type: 'callout',
  version: 1,
  props: { variant, ...(icon ? { icon } : {}) },
  text: [{ text }],
  children: [],
});

/*
 * Through the registry, which is how a host actually activates a plugin. My
 * first attempt passed a `projections` object that `MarkdownOptions` does not
 * have — the tests passed anyway, because the option was ignored and callouts
 * happen to be handled by the built-in path. Typecheck caught it; the tests
 * would not have.
 */
const plugins = new PluginRegistry().register(calloutPlugin);
const rendered = (block: BlockJSON) => blocksToMarkdown([block], { plugins });
const parsed = (markdown: string) => markdownToBlocks(markdown, { plugins });

describe('the callout plugin declares a coherent contract', () => {
  it('announces an API version, so a host can refuse an incompatible plugin', () => {
    expect(calloutPlugin.apiVersion).toBeGreaterThan(0);
    expect(calloutPlugin.schema.type).toBe('callout');
  });

  it('every preset has the fields the picker reads', () => {
    expect(CALLOUT_PRESETS.length).toBeGreaterThan(0);
    for (const preset of CALLOUT_PRESETS) {
      expect(typeof preset.name).toBe('string');
      expect(preset.name).not.toBe('');
      expect(typeof preset.label).toBe('string');
    }
  });
});

describe('the markdown projection round-trips', () => {
  it('emits the Obsidian callout syntax', () => {
    expect(rendered(callout('warning', 'attention'))).toContain('> [!warning] attention');
  });

  it('comes back as a callout with its variant', () => {
    const back = parsed('> [!warning] attention');
    expect(back[0]?.type).toBe('callout');
    expect(back[0]?.props?.['variant']).toBe('warning');
  });

  it('keeps an icon distinct from the text', () => {
    // the icon is a prop, not a prefix on the text — a round trip that merged
    // them would corrupt the block on every save
    const md = rendered(callout('note', 'texte', '!'));
    expect(md).toContain('> [!note] ! texte');
  });

  it('a variant this build has never heard of survives the round trip', () => {
    // §4: what this version does not understand, it does not destroy
    const md = rendered(callout('quantum', 'texte'));
    expect(md).toContain('[!quantum]');
    const back = parsed(md);
    expect(back[0]?.props?.['variant']).toBe('quantum');
  });

  it('but a hyphen or an accent in the variant does not come back — a real limit', () => {
    /*
     * `CALLOUT_LINE` matches `\w+`, which excludes `-` and accented letters. So
     * `[!ma-note]` or `[!noté]` serialises fine and re-imports as a plain
     * quote, losing the block type.
     *
     * Obsidian's own callout types are alphanumeric, so nothing in practice
     * produces one — but §4 promises unknown *props* survive, and a reader
     * would expect that to cover this. Recorded as a known edge rather than
     * silently narrowed: widening the pattern is a one-character change whenever
     * a plugin wants it.
     */
    const md = rendered(callout('ma-note', 'texte'));
    expect(md).toContain('[!ma-note]');
    const back = parsed(md);
    expect(back[0]?.type).not.toBe('callout');
  });

  it('defaults to note when no variant is set', () => {
    const bare: BlockJSON = { id: 'c', type: 'callout', version: 1, props: {}, text: [{ text: 'nu' }], children: [] };
    expect(rendered(bare)).toContain('> [!note] nu');
  });
});
