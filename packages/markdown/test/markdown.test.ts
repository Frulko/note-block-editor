import { describe, expect, it } from 'vitest';
import type { BlockJSON, BlockPlugin, Run } from '@nbe/core';
import { PLUGIN_API_VERSION, PluginRegistry } from '@nbe/core';
import { blocksToMarkdown, markdownToBlocks, markdownToRuns, runsToMarkdown } from '../src/index';

function b(type: string, extra: Partial<Omit<BlockJSON, 'id' | 'type' | 'version'>> = {}): BlockJSON {
  return { id: 'x', type, version: 1, ...extra };
}

/** Recursively drop ids for structural comparison. */
function stripIds(blocks: BlockJSON[]): unknown[] {
  return blocks.map(({ id: _id, children, ...rest }) => ({
    ...rest,
    ...(children?.length ? { children: stripIds(children) } : {}),
  }));
}

describe('runsToMarkdown', () => {
  it('serializes single marks', () => {
    expect(runsToMarkdown([{ text: 'b', marks: [{ type: 'bold' }] }])).toBe('**b**');
    expect(runsToMarkdown([{ text: 'i', marks: [{ type: 'italic' }] }])).toBe('*i*');
    expect(runsToMarkdown([{ text: 's', marks: [{ type: 'strike' }] }])).toBe('~~s~~');
    expect(runsToMarkdown([{ text: 'c', marks: [{ type: 'code' }] }])).toBe('`c`');
    expect(runsToMarkdown([{ text: 'u', marks: [{ type: 'underline' }] }])).toBe('<u>u</u>');
    expect(runsToMarkdown([{ text: 'l', marks: [{ type: 'link', attrs: { href: 'http://x' } }] }])).toBe(
      '[l](http://x)',
    );
  });

  it('nests combined marks', () => {
    expect(runsToMarkdown([{ text: 'bi', marks: [{ type: 'bold' }, { type: 'italic' }] }])).toBe('***bi***');
    expect(
      runsToMarkdown([{ text: 'bl', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'http://x' } }] }]),
    ).toBe('[**bl**](http://x)');
  });

  it('escapes control chars in plain text', () => {
    expect(runsToMarkdown([{ text: 'a * b _ c ` d' }])).toBe('a \\* b \\_ c \\` d');
  });

  it('handles undefined and mixed runs', () => {
    expect(runsToMarkdown(undefined)).toBe('');
    expect(runsToMarkdown([{ text: 'a ' }, { text: 'b', marks: [{ type: 'bold' }] }, { text: ' c' }])).toBe(
      'a **b** c',
    );
  });
});

describe('markdownToRuns', () => {
  it('parses single marks', () => {
    expect(markdownToRuns('**b**')).toEqual([{ text: 'b', marks: [{ type: 'bold' }] }]);
    expect(markdownToRuns('*i*')).toEqual([{ text: 'i', marks: [{ type: 'italic' }] }]);
    expect(markdownToRuns('_i_')).toEqual([{ text: 'i', marks: [{ type: 'italic' }] }]);
    expect(markdownToRuns('~~s~~')).toEqual([{ text: 's', marks: [{ type: 'strike' }] }]);
    expect(markdownToRuns('`c`')).toEqual([{ text: 'c', marks: [{ type: 'code' }] }]);
    expect(markdownToRuns('[t](http://x)')).toEqual([
      { text: 't', marks: [{ type: 'link', attrs: { href: 'http://x' } }] },
    ]);
  });

  it('parses combined marks', () => {
    expect(markdownToRuns('***bi***')).toEqual([{ text: 'bi', marks: [{ type: 'bold' }, { type: 'italic' }] }]);
    expect(markdownToRuns('**bold *and italic***')).toEqual([
      { text: 'bold ', marks: [{ type: 'bold' }] },
      { text: 'and italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ]);
  });

  it('does not nest inside code spans', () => {
    expect(markdownToRuns('`**not bold**`')).toEqual([{ text: '**not bold**', marks: [{ type: 'code' }] }]);
  });

  it('keeps unmatched markers literal', () => {
    expect(markdownToRuns('*foo')).toEqual([{ text: '*foo' }]);
    expect(markdownToRuns('a ** b')).toEqual([{ text: 'a ** b' }]);
    expect(markdownToRuns('[foo] bar')).toEqual([{ text: '[foo] bar' }]);
  });

  it('unescapes backslash escapes', () => {
    expect(markdownToRuns('a \\* b \\` c')).toEqual([{ text: 'a * b ` c' }]);
  });

  it('inline round-trips markdown strings', () => {
    for (const md of [
      '**b**',
      '*i*',
      '~~s~~',
      '`code`',
      '[t](http://example.com)',
      '***bi***',
      '[**bold link**](http://x)',
      'plain then **bold** then *italic* then `code`',
      '~~**struck bold**~~',
    ]) {
      expect(runsToMarkdown(markdownToRuns(md))).toBe(md);
    }
  });

  it('inline round-trips runs', () => {
    const runs: Run[] = [
      { text: 'a ' },
      { text: 'b', marks: [{ type: 'bold' }] },
      { text: ' and ' },
      { text: 'code * stays', marks: [{ type: 'code' }] },
    ];
    expect(markdownToRuns(runsToMarkdown(runs))).toEqual(runs);
  });
});

describe('blocksToMarkdown', () => {
  it('serializes each block type', () => {
    expect(blocksToMarkdown([b('heading', { props: { level: 2 }, text: [{ text: 'Title' }] })])).toBe('## Title');
    expect(blocksToMarkdown([b('divider')])).toBe('---');
    expect(blocksToMarkdown([b('image', { props: { src: 'http://i/p.png' }, text: [{ text: 'cap' }] })])).toBe(
      '![cap](http://i/p.png)',
    );
    expect(blocksToMarkdown([b('link_to_page', { props: { title: 'Home' } })])).toBe('[[Home]]');
    expect(blocksToMarkdown([b('link_to_page')])).toBe('[[page]]');
    expect(blocksToMarkdown([b('to_do', { props: { checked: true }, text: [{ text: 'done' }] })])).toBe('- [x] done');
    expect(blocksToMarkdown([b('quote', { text: [{ text: 'wise' }] })])).toBe('> wise');
  });

  it('aliased wikilinks keep their target, inline and as a block', () => {
    // `[[target|alias]]` used to collapse onto the alias, breaking the link on save
    expect(stripIds(markdownToBlocks('a [[folder/note|nice name]] b'))).toEqual(
      stripIds([
        b('paragraph', {
          text: [
            { text: 'a ' },
            { text: 'nice name', marks: [{ type: 'mention', attrs: { target: 'folder/note' } }] },
            { text: ' b' },
          ],
        }),
      ]),
    );
    expect(blocksToMarkdown(markdownToBlocks('a [[folder/note|nice name]] b'))).toBe('a [[folder/note|nice name]] b');
    expect(blocksToMarkdown(markdownToBlocks('[[folder/note|nice name]]'))).toBe('[[folder/note|nice name]]');
    expect(blocksToMarkdown(markdownToBlocks('[[Plain]]'))).toBe('[[Plain]]');
  });

  it('separates blocks with blank lines except consecutive list items', () => {
    const md = blocksToMarkdown([
      b('heading', { props: { level: 1 }, text: [{ text: 'H' }] }),
      b('bulleted_list_item', { text: [{ text: 'one' }] }),
      b('bulleted_list_item', { text: [{ text: 'two' }] }),
      b('to_do', { props: { checked: false }, text: [{ text: 'task' }] }),
      b('paragraph', { text: [{ text: 'after' }] }),
    ]);
    expect(md).toBe('# H\n\n- one\n- two\n- [ ] task\n\nafter');
  });

  it('indents children by 4 spaces', () => {
    const md = blocksToMarkdown([
      b('bulleted_list_item', {
        text: [{ text: 'parent' }],
        children: [
          b('bulleted_list_item', {
            text: [{ text: 'child' }],
            children: [b('bulleted_list_item', { text: [{ text: 'grandchild' }] })],
          }),
        ],
      }),
    ]);
    expect(md).toBe('- parent\n    - child\n        - grandchild');
  });

  it('serializes callout with icon and quoted children', () => {
    const md = blocksToMarkdown([
      b('callout', {
        props: { icon: '💡' },
        text: [{ text: 'heads up' }],
        children: [b('paragraph', { text: [{ text: 'details' }] })],
      }),
    ]);
    expect(md).toBe('> [!note] 💡 heads up\n> details');
  });

  it('serializes toggle as a list item that says it is one, and comes back a toggle', () => {
    const md = blocksToMarkdown([
      b('toggle', {
        props: { collapsed: true },
        text: [{ text: 'more' }],
        children: [b('paragraph', { text: [{ text: 'hidden' }] })],
      }),
    ]);
    // the blank line is load-bearing: written tight, the indented child is a
    // lazy continuation and comes back merged into the item's own text
    expect(md).toBe('- more <!-- nbe:toggle {"props":{"collapsed":true}} -->\n\n    hidden');
    const back = markdownToBlocks(md);
    expect(back).toHaveLength(1);
    expect(back[0]!.type).toBe('toggle');
    expect(back[0]!.props).toEqual({ collapsed: true });
    expect(back[0]!.text).toEqual([{ text: 'more' }]);
    expect(back[0]!.children![0]!.text).toEqual([{ text: 'hidden' }]);
  });

  it('leaves a toggle that is open and empty-propped as a bare marker', () => {
    // `collapsed: false` is the default state, but the marker still rides —
    // without it the block comes back as a bullet, which is a different block
    expect(blocksToMarkdown([b('toggle', { text: [{ text: 'plié' }] })])).toBe('- plié <!-- nbe:toggle -->');
  });

  it('writes a column layout between markers, and reads it back as one', () => {
    // it used to flatten — 'left\nright', the contents one column after the
    // other — which in a vault, where Markdown *is* the document, is a layout
    // that dissolves the first time the note is saved
    const layout = b('column_list', {
      children: [
        b('column', { props: { ratio: 2 }, children: [b('paragraph', { text: [{ text: 'left' }] })] }),
        b('column', { children: [b('paragraph', { text: [{ text: 'right' }] })] }),
      ],
    });
    const md = blocksToMarkdown([layout]);
    expect(md).toBe(
      [
        '<!-- nbe:column_list -->',
        '<!-- nbe:column {"props":{"ratio":2}} -->',
        'left',
        '<!-- nbe:column -->',
        'right',
        '<!-- /nbe:column_list -->',
      ].join('\n'),
    );

    const [back] = markdownToBlocks(md);
    expect(back?.type).toBe('column_list');
    expect(back?.children?.map((c) => c.type)).toEqual(['column', 'column']);
    expect(back?.children?.[0]?.props).toEqual({ ratio: 2 });
    expect(back?.children?.[1]?.children?.[0]?.text).toEqual([{ text: 'right' }]);
  });

  it('keeps a nested layout inside the column that holds it', () => {
    // stopping at the first close would end the outer layout inside the inner
    // one, which reads back as a document that has quietly lost half its blocks
    const md = [
      '<!-- nbe:column_list -->',
      '<!-- nbe:column -->',
      '<!-- nbe:column_list -->',
      '<!-- nbe:column -->',
      'a',
      '<!-- nbe:column -->',
      'b',
      '<!-- /nbe:column_list -->',
      '<!-- nbe:column -->',
      'c',
      '<!-- /nbe:column_list -->',
    ].join('\n');
    const [outer] = markdownToBlocks(md);
    expect(outer?.children?.length).toBe(2);
    expect(outer?.children?.[0]?.children?.[0]?.type).toBe('column_list');
    expect(outer?.children?.[1]?.children?.[0]?.text).toEqual([{ text: 'c' }]);
    expect(blocksToMarkdown(markdownToBlocks(md))).toBe(md);
  });

  it('leaves an unclosed layout alone rather than eating the rest of the note', () => {
    const md = ['<!-- nbe:column_list -->', '<!-- nbe:column -->', 'a', '', 'du texte après'].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocksToMarkdown(blocks)).toContain('du texte après');
  });

  it('marks unknown types with an HTML comment and keeps children', () => {
    const md = blocksToMarkdown([
      b('bookmark_wat', { children: [b('paragraph', { text: [{ text: 'kept' }] })] }),
    ]);
    expect(md).toBe('<!-- nbe:bookmark_wat -->\nkept');
  });
});

/**
 * The mechanism, rather than the block types that happen to use it: what a
 * line cannot spell is declared on the *spec*, so a block type — built in or
 * brought by a plugin — starts surviving the file without this package, or the
 * plugin's own projection, learning anything new.
 */
describe('what a line cannot spell is declared, not coded', () => {
  /** A plugin whose line says its type but nothing about its props. */
  const gauge: BlockPlugin = {
    apiVersion: PLUGIN_API_VERSION,
    schema: { type: 'gauge', version: 1, inline: false, spelledProps: [] },
    markdown: {
      toMarkdown: () => [':gauge:'],
      fromMarkdown: [
        {
          match: /^:gauge:/,
          parse: (lines, start) =>
            /^:gauge:/.test(lines[start] ?? '')
              ? { block: { id: '', type: 'gauge', version: 1, props: {}, text: [], children: [], parentId: null }, consumed: 1 }
              : null,
        },
      ],
    },
  };
  const plugins = new PluginRegistry().registerAll([gauge]);

  it("carries a plugin's props with no change to its projection", () => {
    const md = blocksToMarkdown([b('gauge', { props: { value: 42, unit: '%' } })], { plugins });
    expect(md).toBe(':gauge: <!-- nbe:gauge {"props":{"value":42,"unit":"%"}} -->');
    expect(markdownToBlocks(md, { plugins })[0]!.props).toEqual({ value: 42, unit: '%' });
  });

  it('writes nothing extra when the block has nothing the line cannot say', () => {
    expect(blocksToMarkdown([b('gauge')], { plugins })).toBe(':gauge:');
  });

  it('keeps a colour, on any block that declares its syntax', () => {
    const md = blocksToMarkdown([
      b('heading', { props: { level: 2, color: 'red' }, text: [{ text: 'Titre' }] }),
      b('paragraph', { props: { backgroundColor: 'yellow' }, text: [{ text: 'surligné' }] }),
    ]);
    expect(md.split('\n')[0]).toBe('## Titre <!-- nbe:heading {"props":{"color":"red"}} -->');
    const back = markdownToBlocks(md);
    expect(back[0]!.props).toEqual({ level: 2, color: 'red' });
    expect(back[1]!.props).toEqual({ backgroundColor: 'yellow' });
    // and the text is the text: the marker is never content
    expect(back[1]!.text).toEqual([{ text: 'surligné' }]);
  });

  it('leaves them out when the text is going somewhere else', () => {
    const blocks = [b('toggle', { text: [{ text: 'plié' }] })];
    expect(blocksToMarkdown(blocks, { markers: false })).toBe('- plié');
  });

  it('brings a sub-page home as a sub-page, not as a link to one', () => {
    const md = blocksToMarkdown([b('sub_page', { props: { title: 'Notes', target: 'Notes', pageId: 'p1' } })]);
    expect(md.startsWith('[[Notes]]')).toBe(true);
    const [back] = markdownToBlocks(md);
    expect(back!.type).toBe('sub_page');
    expect(back!.props).toEqual({ title: 'Notes', target: 'Notes', pageId: 'p1' });
  });
});

/**
 * The blocks whose line says less than the block does. A vault is Markdown, so
 * a prop the file cannot spell is a prop lost on every save — and for these
 * two that is not metadata trivia, it is what makes the block render at all.
 */
describe('the props a link line cannot spell', () => {
  it('brings a file back as a file, with its mime and its size', () => {
    const original = b('file', {
      props: { src: 'asset:abc', name: 'contrat.pdf', mime: 'application/pdf', size: 12345 },
    });
    const md = blocksToMarkdown([original]);
    expect(md).toContain('[contrat.pdf](asset:abc)'); // still a link for every other tool
    const [back] = markdownToBlocks(md);
    expect(back!.type).toBe('file');
    expect(back!.props).toEqual(original.props);
  });

  it('leaves a bare link alone — it is prose, not a file', () => {
    expect(markdownToBlocks('[un lien](https://x.test)')[0]!.type).toBe('paragraph');
  });

  it('keeps an image caption, alignment and width', () => {
    const original = b('image', {
      props: { src: 'asset:img', caption: 'Le schéma', align: 'center', width: 60 },
      text: [{ text: 'alt' }],
    });
    const md = blocksToMarkdown([original]);
    expect(md.startsWith('![alt](asset:img)')).toBe(true);
    const [back] = markdownToBlocks(md);
    expect(back!.type).toBe('image');
    expect(back!.props).toEqual(original.props);
    expect(back!.text).toEqual(original.text);
  });

  it('writes a plain image as a plain image, with nothing trailing it', () => {
    expect(blocksToMarkdown([b('image', { props: { src: 'a.png' } })])).toBe('![](a.png)');
  });

  it('does not let either line be swallowed by the paragraph above', () => {
    const md = ['du texte', ...blocksToMarkdown([b('file', { props: { src: 'a.pdf', name: 'a.pdf' } })]).split('\n'), 'suite'].join('\n');
    expect(markdownToBlocks(md).map((x) => x.type)).toEqual(['paragraph', 'file', 'paragraph']);
  });
});

/**
 * A block written by a bigger plugin set than the one reading the file. The
 * marker is the only thing standing between it and deletion, so it has to
 * survive the round trip whole — type, props and text.
 */
describe('a block whose plugin is not loaded', () => {
  it('comes back as its own type, not as the literal comment', () => {
    const [block] = markdownToBlocks('<!-- nbe:table_of_contents -->');
    expect(block!.type).toBe('table_of_contents');
  });

  it('keeps its props and its text through a save and a reload', () => {
    const original = b('bookmark_wat', {
      props: { style: 'numbered', url: 'https://x.test' },
      text: [{ text: 'titre' }],
    });
    const md = blocksToMarkdown([original]);
    const [back] = markdownToBlocks(md);
    expect(back!.type).toBe('bookmark_wat');
    expect(back!.props).toEqual(original.props);
    expect(back!.text).toEqual(original.text);
  });

  it('cannot be closed early by a payload of its own', () => {
    const md = blocksToMarkdown([b('bookmark_wat', { props: { note: 'a --> b' } })]);
    expect(md.split('-->').length).toBe(2); // exactly one comment end
    expect(markdownToBlocks(md)[0]!.props).toEqual({ note: 'a --> b' });
  });

  it('keeps the block when the payload is corrupt', () => {
    const [block] = markdownToBlocks('<!-- nbe:bookmark_wat {oops -->');
    expect(block!.type).toBe('bookmark_wat');
    expect(block!.props).toBeUndefined();
  });

  it('is not swallowed by the paragraph above it', () => {
    const blocks = markdownToBlocks('du texte\n<!-- nbe:bookmark_wat -->\nsuite');
    expect(blocks.map((x) => x.type)).toEqual(['paragraph', 'bookmark_wat', 'paragraph']);
  });
});

describe('markdownToBlocks', () => {
  it('parses a realistic pasted snippet', () => {
    const md = [
      '# Project notes',
      '',
      'Some **bold** intro with a [link](http://example.com).',
      '',
      '## Tasks',
      '- [x] ship parser',
      '- [ ] write docs',
      '- misc item',
      '    - nested detail',
      '',
      '1. first',
      '2. second',
      '',
      '> a quote',
      '',
      '> [!note] pay attention',
      '',
      '---',
      '',
      '![diagram](http://img/d.png)',
      '',
      '[[Other Page]]',
    ].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks.map((x) => x.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'to_do',
      'to_do',
      'bulleted_list_item',
      'numbered_list_item',
      'numbered_list_item',
      'quote',
      'callout',
      'divider',
      'image',
      'link_to_page',
    ]);
    expect(blocks[0]!.props).toEqual({ level: 1 });
    expect(blocks[1]!.text).toEqual([
      { text: 'Some ' },
      { text: 'bold', marks: [{ type: 'bold' }] },
      { text: ' intro with a ' },
      { text: 'link', marks: [{ type: 'link', attrs: { href: 'http://example.com' } }] },
      { text: '.' },
    ]);
    expect(blocks[3]!.props).toEqual({ checked: true });
    expect(blocks[4]!.props).toEqual({ checked: false });
    expect(blocks[5]!.children).toHaveLength(1);
    expect(blocks[5]!.children![0]!.type).toBe('bulleted_list_item');
    expect(blocks[11]!.props).toEqual({ src: 'http://img/d.png' });
    expect(blocks[12]!.props).toEqual({ title: 'Other Page', target: 'Other Page' });
    for (const blk of blocks) expect(typeof blk.id).toBe('string');
    expect(new Set(blocks.map((x) => x.id)).size).toBe(blocks.length);
  });

  it('joins consecutive plain lines into one paragraph; a blank line splits', () => {
    expect(stripIds(markdownToBlocks('line one\nline two'))).toEqual([
      { type: 'paragraph', version: 1, text: [{ text: 'line one line two' }] },
    ]);
    expect(stripIds(markdownToBlocks('line one\n\nline two'))).toEqual([
      { type: 'paragraph', version: 1, text: [{ text: 'line one' }] },
      { type: 'paragraph', version: 1, text: [{ text: 'line two' }] },
    ]);
  });

  it('supports tab indentation for children', () => {
    const blocks = markdownToBlocks('- parent\n\t- child');
    expect(blocks[0]!.children![0]!.text).toEqual([{ text: 'child' }]);
  });

  it('folds a wrapped quote into one paragraph, as CommonMark does', () => {
    const blocks = markdownToBlocks('> first\n> second');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('quote');
    expect(blocks[0]!.text).toEqual([{ text: 'first second' }]);
    expect(blocks[0]!.children).toBeUndefined();
  });

  it('a blank quote line starts a real second paragraph inside the quote', () => {
    const blocks = markdownToBlocks('> first\n>\n> second');
    expect(blocks[0]!.text).toEqual([{ text: 'first' }]);
    expect(blocks[0]!.children![0]!.text).toEqual([{ text: 'second' }]);
  });

  it("a callout's [!type] line is a title, never folded into its body", () => {
    const blocks = markdownToBlocks('> [!warning] Careful\n> the body wraps\n> over two lines');
    expect(blocks[0]!.type).toBe('callout');
    expect(blocks[0]!.text).toEqual([{ text: 'Careful' }]);
    expect(blocks[0]!.children![0]!.text).toEqual([{ text: 'the body wraps over two lines' }]);
  });
});

describe('block round-trip', () => {
  it('doc → markdown → doc is structurally identical (ids ignored)', () => {
    const doc: BlockJSON[] = [
      b('heading', { props: { level: 1 }, text: [{ text: 'The Title' }] }),
      b('paragraph', {
        text: [
          { text: 'Hello ' },
          { text: 'bold', marks: [{ type: 'bold' }] },
          { text: ' and ' },
          { text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { text: ' and ' },
          { text: 'code', marks: [{ type: 'code' }] },
        ],
      }),
      b('heading', { props: { level: 2 }, text: [{ text: 'List' }] }),
      b('bulleted_list_item', {
        text: [{ text: 'top' }],
        children: [
          b('bulleted_list_item', {
            text: [{ text: 'mid' }],
            children: [b('bulleted_list_item', { text: [{ text: 'deep' }] })],
          }),
          b('numbered_list_item', { text: [{ text: 'numbered child' }] }),
        ],
      }),
      b('to_do', { props: { checked: true }, text: [{ text: 'done task' }] }),
      b('to_do', { props: { checked: false }, text: [{ text: 'open task' }] }),
      b('quote', { text: [{ text: 'wise words' }] }),
      b('callout', {
        text: [{ text: 'note this' }],
        children: [b('paragraph', { text: [{ text: 'callout body' }] })],
      }),
      b('divider'),
      b('image', { props: { src: 'http://img/x.png' }, text: [{ text: 'a caption' }] }),
      b('link_to_page', { props: { title: 'Linked Page', target: 'Linked Page' } }),
    ];
    const md = blocksToMarkdown(doc);
    expect(stripIds(markdownToBlocks(md))).toEqual(stripIds(doc));
  });

  it('escaping: paragraph containing * and ` survives round-trip', () => {
    const doc: BlockJSON[] = [b('paragraph', { text: [{ text: 'weird *stars* and `ticks` and _under_' }] })];
    const md = blocksToMarkdown(doc);
    expect(md).toBe('weird \\*stars\\* and \\`ticks\\` and \\_under\\_');
    expect(stripIds(markdownToBlocks(md))).toEqual(stripIds(doc));
  });
});

/**
 * Checklists, the thing a note actually gets used for. Both markers Markdown
 * allows, both cases of the tick, nested and mixed with plain bullets.
 */
describe('checklists', () => {
  it('reads every spelling of a task', () => {
    expect(stripIds(markdownToBlocks('- [ ] a\n* [x] b\n+ [X] c'))).toEqual(
      stripIds([
        b('to_do', { props: { checked: false }, text: [{ text: 'a' }] }),
        b('to_do', { props: { checked: true }, text: [{ text: 'b' }] }),
        b('to_do', { props: { checked: true }, text: [{ text: 'c' }] }),
      ]),
    );
  });

  it('reads `+` as a bullet too, which CommonMark allows and this did not', () => {
    expect(stripIds(markdownToBlocks('+ un\n+ deux'))).toEqual(
      stripIds([
        b('bulleted_list_item', { text: [{ text: 'un' }] }),
        b('bulleted_list_item', { text: [{ text: 'deux' }] }),
      ]),
    );
  });

  it('nests tasks under tasks, and bullets under tasks', () => {
    const doc = markdownToBlocks('- [ ] parent\n    - [x] child\n    - bullet');
    expect(stripIds(doc)).toEqual(
      stripIds([
        b('to_do', {
          props: { checked: false },
          text: [{ text: 'parent' }],
          children: [
            b('to_do', { props: { checked: true }, text: [{ text: 'child' }] }),
            b('bulleted_list_item', { text: [{ text: 'bullet' }] }),
          ],
        }),
      ]),
    );
    expect(blocksToMarkdown(doc)).toBe('- [ ] parent\n    - [x] child\n    - bullet');
  });

  it('leaves a task typed into a numbered item alone, unescaped', () => {
    // a numbered checklist is a numbered item whose text starts with `[ ]`,
    // because a to-do has no ordinal to keep. It used to come back as
    // `1. \[ \] fait`, which is the same text and a worse file.
    const md = '1. [ ] fait';
    expect(blocksToMarkdown(markdownToBlocks(md))).toBe(md);
  });

  it('still escapes the brackets that would parse back as a link', () => {
    const doc: BlockJSON[] = [b('paragraph', { text: [{ text: 'see [note](x) and [[page]] but not [1]' }] })];
    const md = blocksToMarkdown(doc);
    expect(md).toBe('see \\[note](x) and \\[[page]] but not [1]');
    expect(stripIds(markdownToBlocks(md))).toEqual(stripIds(doc));
  });
});

/**
 * The marks Markdown has no spelling for. They are written as the HTML both
 * Obsidian and every renderer already understand — and, until now, never read
 * back: underline round-tripped to the literal text `<u>x</u>`.
 */
describe('the marks Markdown cannot spell', () => {
  const trip = (runs: Run[]) => markdownToRuns(runsToMarkdown(runs));

  it('round-trips underline, which it used to lose', () => {
    const runs: Run[] = [{ text: 'sous', marks: [{ type: 'underline' }] }];
    expect(runsToMarkdown(runs)).toBe('<u>sous</u>');
    expect(trip(runs)).toEqual(runs);
  });

  it('round-trips superscript and subscript', () => {
    expect(runsToMarkdown([{ text: '2', marks: [{ type: 'superscript' }] }])).toBe('<sup>2</sup>');
    expect(trip([{ text: 'n', marks: [{ type: 'subscript' }] }])).toEqual([
      { text: 'n', marks: [{ type: 'subscript' }] },
    ]);
  });

  it('keeps the text around them', () => {
    const runs: Run[] = [{ text: 'x' }, { text: '2', marks: [{ type: 'superscript' }] }, { text: ' m' }];
    expect(runsToMarkdown(runs)).toBe('x<sup>2</sup> m');
    expect(trip(runs)).toEqual(runs);
  });

  it('reads `==` as a highlight, and writes one back', () => {
    const highlighted = markdownToRuns('un ==mot== ici');
    expect(highlighted).toEqual([
      { text: 'un ' },
      { text: 'mot', marks: [{ type: 'background', attrs: { color: 'yellow' } }] },
      { text: ' ici' },
    ]);
    expect(runsToMarkdown(highlighted)).toBe('un ==mot== ici');
  });

  it('reads `<mark>` too, which is what other tools write', () => {
    expect(markdownToRuns('<mark>x</mark>')).toEqual([
      { text: 'x', marks: [{ type: 'background', attrs: { color: 'yellow' } }] },
    ]);
  });

  it('leaves prose that merely contains `<` alone', () => {
    expect(markdownToRuns('a < b and <span>c')).toEqual([{ text: 'a < b and <span>c' }]);
    // an unclosed tag is text, not a mark that swallows the rest of the line
    expect(markdownToRuns('<u>oubli')).toEqual([{ text: '<u>oubli' }]);
  });
});
