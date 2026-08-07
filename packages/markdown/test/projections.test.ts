// R5: a plugin's markdown projection replaces the built-in switch for its own
// type, in both directions. The point of the whole exercise is that a block
// declared once cannot render in the editor and vanish from an export, so
// these tests pair every serialize with its parse.
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@nbe/core';
import { calloutPlugin } from '@nbe/blocks-callout';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';
import type { BlockJSON } from '@nbe/core';

const registry = () => new PluginRegistry().register(calloutPlugin);

const callout = (props: Record<string, unknown>, text: string, children: BlockJSON[] = []): BlockJSON => ({
  id: 'c1',
  type: 'callout',
  version: 1,
  ...(Object.keys(props).length ? { props } : {}),
  text: [{ text }],
  ...(children.length ? { children } : {}),
});

describe('a plugin owns its markdown', () => {
  it('serializes through the contributed projection', () => {
    const md = blocksToMarkdown([callout({ variant: 'warning', icon: '⚠️' }, 'Attention')], {
      plugins: registry(),
    });
    expect(md).toBe('> [!warning] ⚠️ Attention');
  });

  it('parses through the contributed rule', () => {
    const [block] = markdownToBlocks('> [!warning] Attention', { plugins: registry() });
    expect(block!.type).toBe('callout');
    expect(block!.props).toEqual({ variant: 'warning' });
  });

  it('round-trips a preset without collapsing it', () => {
    const source = callout({ variant: 'danger' }, 'Erreur');
    const [parsed] = markdownToBlocks(blocksToMarkdown([source], { plugins: registry() }), {
      plugins: registry(),
    });
    expect(parsed!.props).toEqual({ variant: 'danger' });
  });

  it('never writes the default variant into props, so the round-trip is byte-stable', () => {
    const [parsed] = markdownToBlocks('> [!note] Une note', { plugins: registry() });
    // what matters is that no variant is stored, not whether props is {} or absent
    expect(parsed!.props?.['variant']).toBeUndefined();
    expect(blocksToMarkdown([parsed!], { plugins: registry() })).toBe('> [!note] Une note');
  });

  it('mints an id for a block the rule left blank', () => {
    const [block] = markdownToBlocks('> [!info] Info', { plugins: registry() });
    expect(block!.id).toBeTruthy();
  });
});

describe('without the plugin registered', () => {
  it('still serializes, via the built-in handling', () => {
    // the block type is not extracted from the switch yet, so the fallback is
    // the old path — the test that will change when it is
    const md = blocksToMarkdown([callout({ variant: 'warning', icon: '⚠️' }, 'Attention')]);
    expect(md).toContain('[!warning]');
  });

  it('leaves unrelated markdown to the built-in parser', () => {
    const blocks = markdownToBlocks('# Titre\n\n- un\n- deux', { plugins: registry() });
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'bulleted_list_item', 'bulleted_list_item']);
  });
});

describe('the projection travels with the block, not with the view', () => {
  it('works from the DOM-free entry, so markdown never imports the editor', () => {
    // @nbe/blocks-callout's main entry carries schema + projections only; its
    // /dom entry adds the view. This test importing the former is the check.
    expect(calloutPlugin.markdown).toBeDefined();
    expect((calloutPlugin as { view?: unknown }).view).toBeUndefined();
  });

  it('exposes both directions, because one alone degrades silently', () => {
    expect(calloutPlugin.markdown!.toMarkdown).toBeTypeOf('function');
    expect(calloutPlugin.markdown!.fromMarkdown.length).toBeGreaterThan(0);
  });
});
