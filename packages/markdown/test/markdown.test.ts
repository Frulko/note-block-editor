import { describe, expect, it } from 'vitest';
import type { BlockJSON, Run } from '@nbe/core';
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

  it('serializes toggle as a list item (toggle-ness lost) and its child survives a re-read', () => {
    const md = blocksToMarkdown([
      b('toggle', { text: [{ text: 'more' }], children: [b('paragraph', { text: [{ text: 'hidden' }] })] }),
    ]);
    // the blank line is load-bearing: written tight, the indented child is a
    // lazy continuation and comes back merged into the item's own text
    expect(md).toBe('- more\n\n    hidden');
    const back = markdownToBlocks(md);
    expect(back).toHaveLength(1);
    expect(back[0]!.text).toEqual([{ text: 'more' }]);
    expect(back[0]!.children![0]!.text).toEqual([{ text: 'hidden' }]);
  });

  it('flattens column_list contents sequentially', () => {
    const md = blocksToMarkdown([
      b('column_list', {
        children: [
          b('column', { children: [b('paragraph', { text: [{ text: 'left' }] })] }),
          b('column', { children: [b('paragraph', { text: [{ text: 'right' }] })] }),
        ],
      }),
    ]);
    expect(md).toBe('left\nright');
  });

  it('marks unknown types with an HTML comment and keeps children', () => {
    const md = blocksToMarkdown([
      b('bookmark_wat', { children: [b('paragraph', { text: [{ text: 'kept' }] })] }),
    ]);
    expect(md).toBe('<!-- nbe:bookmark_wat -->\nkept');
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
