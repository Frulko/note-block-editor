import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../src/index';
import type { BlockJSON } from '@nbe/core';

const callout = (props: Record<string, unknown>, text: string): BlockJSON => ({
  id: 'c',
  type: 'callout',
  version: 1,
  props,
  text: [{ text }],
});

describe('callout variants map to Obsidian callout types', () => {
  it('serializes the variant as the callout type', () => {
    expect(blocksToMarkdown([callout({ variant: 'warning', icon: '⚠️' }, 'attention')])).toContain(
      '> [!warning] ⚠️ attention',
    );
    expect(blocksToMarkdown([callout({ variant: 'danger' }, 'stop')])).toContain('> [!danger] stop');
  });

  it('falls back to note when no variant is set', () => {
    expect(blocksToMarkdown([callout({}, 'simple')])).toContain('> [!note] simple');
  });

  it('parses the type back into the variant', () => {
    const blocks = markdownToBlocks('> [!warning] attention');
    expect(blocks[0]!.type).toBe('callout');
    expect(blocks[0]!.props?.['variant']).toBe('warning');
  });

  it('does not store the default variant, keeping the round-trip stable', () => {
    const blocks = markdownToBlocks('> [!note] simple');
    expect(blocks[0]!.props?.['variant']).toBeUndefined();
  });

  it('accepts foldable callout markers (> [!info]- ) as Obsidian writes them', () => {
    const blocks = markdownToBlocks('> [!info]- replié');
    expect(blocks[0]!.props?.['variant']).toBe('info');
    expect(blocks[0]!.text?.[0]?.text).toBe('replié');
  });

  it('round-trips a non-default variant unchanged', () => {
    const md = blocksToMarkdown([callout({ variant: 'success' }, 'ok')]);
    expect(markdownToBlocks(md)[0]!.props?.['variant']).toBe('success');
  });
});
