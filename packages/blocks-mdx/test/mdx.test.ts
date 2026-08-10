import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks } from '@nbe/markdown';
import { componentName, mdxBlocks } from '../src/index';
import { parseProps, readTag, writeProps } from '../src/components';

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

/**
 * The half the host supplies.
 *
 * @remarks
 * The block still evaluates nothing — that decision is not up for revision, and
 * it is what these check. The file supplies *data*: a name, some attributes,
 * the text between the tags. The host supplies the *code*, which is code the
 * host wrote and already trusts. `<Counter start={3} />` can become a real
 * counter without a single character of the file being executed.
 *
 * Reported 2026-08-10 as « le mdx doit être interactif non ? » — and it can be,
 * this way round.
 */
describe('what the host is handed for a tag', () => {
  it('reads a self-closing tag, its name and its props', () => {
    const tag = readTag('<Counter start={3} label="Vues" wide />')!;
    expect(tag.name).toBe('Counter');
    expect(tag.children).toBe('');
    expect(parseProps(tag.openingTag)).toEqual({ start: 3, label: 'Vues', wide: true });
  });

  it('reads the text between an open and a close', () => {
    const tag = readTag('<Callout type="info">\n  Deux lignes\n  de texte\n</Callout>')!;
    expect(tag.name).toBe('Callout');
    expect(parseProps(tag.openingTag)).toEqual({ type: 'info' });
    expect(tag.children.trim()).toBe('Deux lignes\n  de texte');
  });

  it('parses a braced value as JSON when it is JSON', () => {
    const props = parseProps('<X n={2} yes={true} list={[1,2]} obj={{"a":1}} />');
    expect(props).toEqual({ n: 2, yes: true, list: [1, 2], obj: { a: 1 } });
  });

  it('hands an expression over as text rather than evaluating it', () => {
    // the whole point: `{count + 1}` is a string here, and a renderer may do
    // nothing with it. Nothing out of the file runs.
    expect(parseProps('<X v={count + 1} />')).toEqual({ v: 'count + 1' });
  });

  it('is null for something that is not a component tag', () => {
    expect(readTag('<div>html, which markdown already carries</div>')).toBeNull();
    expect(readTag('du texte')).toBeNull();
  });
});

/**
 * And the invariant that makes rendering safe to add at all: **what is drawn
 * has no bearing on what is written.** The block stores `source` verbatim, so
 * a host with components and a host without produce the same file.
 */
describe('rendering changes nothing about the file', () => {
  it('a tag the host would draw still round-trips verbatim', () => {
    for (const src of [
      '<Counter start={3} />',
      '<Callout type="info" title="Un composant">\n  Son balisage est conservé.\n</Callout>',
    ]) {
      expect(trip(src)).toBe(src);
    }
  });
});

/**
 * State that survives a reload, written where state belongs.
 *
 * @remarks
 * A host's component keeps its count in a closure, so reopening the file put it
 * back to whatever the tag said. The state *is* a prop — so it goes in the tag,
 * the file says what the counter is on, and any other MDX tool reads the same
 * value. The alternatives both cost something this block will not pay: a marker
 * comment breaks the byte-for-byte promise, and a frontmatter key needs a
 * stable id the block does not persist.
 *
 * The rule that makes it safe is that only the patched keys are rewritten.
 * `{count + 1}` parses to the *string* `'count + 1'` — never evaluated — so
 * re-serialising every attribute would emit `="count + 1"` and quietly turn an
 * expression into a string literal.
 */
describe('writing a prop back into the tag', () => {
  it('changes the one it was given', () => {
    expect(writeProps('<Counter start={3} />', { start: 5 })).toBe('<Counter start={5} />');
  });

  it('adds one that was not there', () => {
    expect(writeProps('<Counter />', { start: 2 })).toBe('<Counter start={2} />');
    expect(writeProps('<Counter label="Vues" />', { start: 2 })).toBe('<Counter label="Vues" start={2} />');
  });

  it('removes one when given undefined', () => {
    expect(writeProps('<Counter start={3} label="Vues" />', { start: undefined })).toBe(
      '<Counter label="Vues" />',
    );
  });

  it('leaves an expression exactly as it was written', () => {
    // the whole hazard: this must not become `total="count + 1"`
    const out = writeProps('<Counter start={3} total={count + 1} />', { start: 9 });
    expect(out).toBe('<Counter start={9} total={count + 1} />');
  });

  it('keeps the children and the closing tag', () => {
    const src = '<Callout type="info">\n  du texte\n</Callout>';
    expect(writeProps(src, { type: 'warning' })).toBe('<Callout type="warning">\n  du texte\n</Callout>');
  });

  it('writes a string as a quoted attribute, and a value that would need escaping as JSX', () => {
    expect(writeProps('<X />', { a: 'simple' })).toBe('<X a="simple" />');
    expect(writeProps('<X />', { a: 'avec "guillemets"' })).toBe('<X a={"avec \\"guillemets\\""} />');
  });

  it('round-trips what it wrote', () => {
    const out = writeProps('<Counter start={3} label="Vues" />', { start: 7 });
    expect(trip(out)).toBe(out);
    expect(parseProps(readTag(out)!.openingTag)).toEqual({ start: 7, label: 'Vues' });
  });
});
