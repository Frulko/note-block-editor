import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { componentName, mdxBlocks } from '../src/index';

/**
 * The point is not what this renders. It is that an `.mdx` file opens here and
 * closes byte-for-byte unchanged — without this, a component tag is prose, its
 * angle brackets are escaped on save, and the file stops being MDX.
 */
const plugins = new PluginRegistry().registerAll(mdxBlocks);
const trip = (src: string) => blocksToMarkdown(markdownToBlocks(src, { plugins }), { plugins });

describe('a component survives the file', () => {
  it('self-closing, with props', () => {
    const src = '<Callout type="warning" count={2} />';
    expect(markdownToBlocks(src, { plugins })[0]!.type).toBe('mdx_component');
    expect(trip(src)).toBe(src);
  });

  it('paired, over several lines, with Markdown inside it', () => {
    const src = '<Callout type="note">\n\nDu **texte**.\n\n</Callout>';
    const blocks = markdownToBlocks(src, { plugins });
    expect(blocks.map((b) => b.type)).toEqual(['mdx_component']);
    expect(trip(src)).toBe(src);
  });

  it('leaves the prose around it alone', () => {
    const src = 'Avant.\n\n<Note id="a" />\n\nAprès.';
    expect(markdownToBlocks(src, { plugins }).map((b) => b.type)).toEqual([
      'paragraph',
      'mdx_component',
      'paragraph',
    ]);
    expect(trip(src)).toBe(src);
  });

  it('a lowercase tag is HTML, and stays prose — JSX draws that line too', () => {
    const blocks = markdownToBlocks('<div>bonjour</div>', { plugins });
    expect(blocks[0]!.type).toBe('paragraph');
  });

  it('an unclosed tag is prose, not a component that swallows the rest', () => {
    const blocks = markdownToBlocks('<Callout type="x">\n\ndu texte', { plugins });
    expect(blocks.every((b) => b.type !== 'mdx_component')).toBe(true);
  });

  it('names the component, for the card that shows it', () => {
    expect(componentName('<Callout type="a" />')).toBe('Callout');
    expect(componentName('<Foo.Bar />')).toBe('Foo.Bar');
    expect(componentName('pas un composant')).toBe('Composant');
  });
});
