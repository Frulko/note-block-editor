import { describe, expect, it } from 'vitest';
import type { BlockJSON } from '@nbe/core';
import { PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { embedBlocks, embedMode, frameUrl, providerFor } from '../src/index';

/**
 * The table is the plugin, so the table is what is tested.
 *
 * The failure that matters here is silent: a provider whose embed URL is
 * subtly wrong shows an empty box, and an empty box looks exactly like a slow
 * network. So each line is pinned to the URL it must produce, and the two
 * lines that cannot be framed are pinned to *not* producing one.
 */

const plugins = new PluginRegistry().registerAll(embedBlocks);

const block = (props: Record<string, unknown>): BlockJSON => ({ id: 'e', type: 'embed', version: 1, props });

describe('the provider table', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/embed/abc123'],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://www.loom.com/share/abc123', 'https://www.loom.com/embed/abc123'],
    ['https://www.dailymotion.com/video/x8abcd', 'https://www.dailymotion.com/embed/video/x8abcd'],
    ['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'],
    ['https://codepen.io/anne/pen/abcXYZ', 'https://codepen.io/anne/embed/abcXYZ'],
    ['https://codesandbox.io/s/happy-tree-42', 'https://codesandbox.io/embed/happy-tree-42'],
  ])('turns %s into %s', (input, expected) => {
    expect(frameUrl(input)).toBe(expected);
  });

  it('hands Figma its own URL, encoded', () => {
    const url = 'https://www.figma.com/file/abc/Design?node-id=1%3A2';
    expect(frameUrl(url)).toBe(`https://www.figma.com/embed?embed_host=carnet&url=${encodeURIComponent(url)}`);
  });

  it('frames an unrecognised https URL as itself', () => {
    expect(frameUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('refuses to frame a Gist, which sends X-Frame-Options', () => {
    // a blank box looks exactly like a slow network; a card says where it goes
    expect(frameUrl('https://gist.github.com/anne/abc')).toBeNull();
    expect(embedMode({ src: 'https://gist.github.com/anne/abc' })).toBe('card');
  });

  it('refuses a provider URL with no id in it', () => {
    // youtube.com/ with nothing after it is the home page, and framing it
    // gives a page that refuses to be framed
    expect(frameUrl('https://www.youtube.com/')).toBeNull();
    expect(frameUrl('https://vimeo.com/channels/staffpicks')).toBeNull();
  });

  it('refuses anything that is not http(s)', () => {
    expect(frameUrl('javascript:alert(1)')).toBeNull();
    expect(frameUrl('pas une url')).toBeNull();
  });

  it('reads a PDF by its path, not by its host', () => {
    expect(providerFor('https://example.com/files/rapport.pdf')?.id).toBe('pdf');
  });
});

describe('the mode', () => {
  it('is what the block says, when it says one', () => {
    expect(embedMode({ src: 'https://youtu.be/x', mode: 'card' })).toBe('card');
  });

  it('falls back to a card for anything unframeable', () => {
    expect(embedMode({ src: 'https://gist.github.com/a/b' })).toBe('card');
  });

  it('is srcdoc for a block with markup and no URL', () => {
    expect(embedMode({ html: '<p>x</p>' })).toBe('srcdoc');
  });
});

describe('an embed in Markdown', () => {
  it('is a link plus the marker that says it was one', () => {
    const md = blocksToMarkdown([block({ src: 'https://youtu.be/x', title: 'La vidéo', height: 600 })], { plugins });
    expect(md).toBe('[La vidéo](https://youtu.be/x) <!-- nbe:embed {"props":{"height":600}} -->');
  });

  it('round-trips byte for byte', () => {
    const md = blocksToMarkdown([block({ src: 'https://vimeo.com/76979871', title: 'Clip', mode: 'card' })], {
      plugins,
    });
    expect(blocksToMarkdown(markdownToBlocks(md, { plugins }), { plugins })).toBe(md);
  });

  it('leaves a lone link as prose', () => {
    // any rule broad enough to claim one would claim every paragraph that
    // happens to be a link, which is what `markdownAmbiguous` exists to say
    const blocks = markdownToBlocks('[un lien](https://example.com)', { plugins });
    expect(blocks[0]?.type).not.toBe('embed');
  });
});
