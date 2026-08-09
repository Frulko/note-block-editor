import { describe, expect, it } from 'vitest';
import { Editor, PluginRegistry, matchAutoformat, plainText, type BlockJSON } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { renderBlocksToHTML } from '@nbe/static-renderer';
import { codeBlocks, codePlugin, isLoaded, loadLanguage, tokenize, detectLanguage } from '../src/index';

/**
 * The code block, through the plugin path. `@nbe/markdown`, `@nbe/core` and
 * `@nbe/static-renderer` no longer know what a fence is, so every test here
 * registers the plugin — and one deliberately does not, because the honest
 * fallback for a block nobody registered is the thing this contract exists to
 * guarantee.
 */

const plugins = new PluginRegistry().registerAll(codeBlocks);
const toMd = (blocks: BlockJSON[]) => blocksToMarkdown(blocks, { plugins });
const fromMd = (md: string) => markdownToBlocks(md, { plugins });

const codeBlock = (text: string, language?: string): BlockJSON => ({
  id: 'c1',
  type: 'code',
  version: 1,
  ...(language ? { props: { language } } : {}),
  ...(text ? { text: [{ text }] } : {}),
});

describe('the fence projection', () => {
  it('writes the language as the info string', () => {
    expect(toMd([codeBlock('let x = 1;', 'typescript')])).toBe('```typescript\nlet x = 1;\n```');
  });

  it('omits it for plain text', () => {
    expect(toMd([codeBlock('deux\nlignes')])).toBe('```\ndeux\nlignes\n```');
  });

  it('reads a fence back, language included', () => {
    const [block] = fromMd('```python\nprint(1)\n```');
    expect(block!.type).toBe('code');
    expect(block!.props).toEqual({ language: 'python' });
    expect(plainText(block!.text)).toBe('print(1)');
  });

  it('round-trips a note byte for byte', () => {
    const md = '```js\nconst x = 1;\n```';
    expect(toMd(fromMd(md)).trim()).toBe(md);
  });

  it('ends the paragraph above it', () => {
    const blocks = fromMd('Du texte\n```js\nconst x = 1;\n```');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'code']);
  });

  it('closes an unterminated fence at the end of the file', () => {
    // the alternative is swallowing the rest of the document
    const blocks = fromMd('```\nsans fin');
    expect(blocks).toHaveLength(1);
    expect(plainText(blocks[0]!.text)).toBe('sans fin');
  });

  it('is a marker comment when the plugin is not registered, code and all', () => {
    // the marker used to carry the type alone, so a note saved by a host
    // without this plugin came back as an empty code block
    const md = blocksToMarkdown([codeBlock('x', 'js')]);
    expect(md).toContain('<!-- nbe:code ');
    const [back] = markdownToBlocks(md);
    expect(back!.type).toBe('code');
    expect(back!.props).toEqual({ language: 'js' });
    expect(plainText(back!.text as never)).toBe('x');
  });
});

describe('the ``` shortcut', () => {
  it('belongs to the plugin, not to core', () => {
    expect(matchAutoformat('```')).toBeNull();
    expect(matchAutoformat('```', plugins)?.type).toBe('code');
  });
});

describe('tokenizing', () => {
  it('says nothing about a grammar it has not loaded', () => {
    // uncoloured code reads fine; a network round trip in the keystroke path
    // does not, which is why this is silent rather than awaited
    expect(isLoaded('rust')).toBe(false);
    expect(tokenize('fn main() {}', 'rust')).toEqual([]);
  });

  it('returns non-overlapping ranges in order, once loaded', async () => {
    await loadLanguage('javascript');
    const code = 'const x = 1; // note';
    const tokens = tokenize(code, 'javascript');
    expect(tokens.length).toBeGreaterThan(2);
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.start).toBeGreaterThanOrEqual(tokens[i - 1]!.end);
    }
    // the ranges point at what they claim to
    const byGroup = Object.fromEntries(tokens.map((t) => [t.group, code.slice(t.start, t.end)]));
    expect(byGroup['keyword']).toBe('const');
    expect(byGroup['number']).toBe('1');
    expect(byGroup['comment']).toBe('// note');
  });

  it('resolves a nested scope to the innermost one', async () => {
    await loadLanguage('javascript');
    const code = 'const s = `a ${x} b`;';
    const tokens = tokenize(code, 'javascript');
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.start).toBeGreaterThanOrEqual(tokens[i - 1]!.end);
    }
  });

  it('detects a language, among those loaded, or admits it cannot', async () => {
    await loadLanguage('python');
    expect(detectLanguage('def hello(name):\n    return f"hi {name}"')).toBe('python');
    expect(detectLanguage('x')).toBeNull();
  });
});

describe('the static HTML projection', () => {
  it('emits spans for a loaded grammar — an export has no caret to protect', async () => {
    await loadLanguage('javascript');
    const html = renderBlocksToHTML([codeBlock('const x = 1;', 'javascript')] as never, { plugins });
    expect(html).toContain('<pre><code class="language-javascript">');
    expect(html).toContain('<span class="nbe-tok-keyword">const</span>');
  });

  it('still ships the code, tagged, when the grammar is absent', () => {
    const html = renderBlocksToHTML([codeBlock('fn main() {}', 'rust')] as never, { plugins });
    expect(html).toContain('<code class="language-rust">fn main() {}</code>');
  });

  it('escapes what it renders', () => {
    const html = renderBlocksToHTML([codeBlock('a < b && "c"', 'plain')] as never, { plugins });
    expect(html).toContain('a &lt; b &amp;&amp; &quot;c&quot;');
  });
});

describe('the plugin registers cleanly', () => {
  it('teaches an editor the type it did not know', () => {
    expect(new Editor().schema.has('code')).toBe(false);
    expect(new Editor({ plugins: codeBlocks }).schema.has('code')).toBe(true);
  });

  it('declares its markdown in both directions', () => {
    expect(codePlugin.markdown?.toMarkdown).toBeTypeOf('function');
    expect(codePlugin.markdown?.fromMarkdown.length).toBeGreaterThan(0);
  });
});
