// @vitest-environment happy-dom
//
// Paste fixture corpus (ARCHITECTURE §7): realistic clipboard HTML from the
// sources users actually paste from. Paste is the highest-regression surface —
// every fixture here is a regression tripwire for htmlToBlocks.
import { describe, expect, it } from 'vitest';
import { plainText, type BlockJSON } from '@nbe/core';
import { htmlToBlocks, tsvToTable } from '../src/clipboard';

const types = (blocks: BlockJSON[]) => blocks.map((b) => b.type);
const texts = (blocks: BlockJSON[]) => blocks.map((b) => plainText(b.text));
const marksOf = (b: BlockJSON, runIdx: number) => (b.text?.[runIdx]?.marks ?? []).map((m) => m.type);

describe('paste: Google Docs', () => {
  // GDocs wraps everything in <b id="docs-internal-guid-..." style="font-weight:normal">
  // and expresses formatting through styled spans.
  const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-4f2a1b3c-7fff-1a2b">
    <p dir="ltr" style="line-height:1.38;"><span style="font-size:11pt;font-family:Arial;">Un paragraphe </span><span style="font-size:11pt;font-weight:700;">gras</span><span style="font-size:11pt;"> et </span><span style="font-size:11pt;font-style:italic;">italique</span><span style="font-size:11pt;">.</span></p>
    <h2 dir="ltr"><span style="font-size:16pt;">Sous-titre</span></h2>
    <ul style="margin-top:0;">
      <li dir="ltr" style="list-style-type:disc;"><p dir="ltr" role="presentation"><span>premier</span></p></li>
      <li dir="ltr" style="list-style-type:disc;"><p dir="ltr" role="presentation"><span>second</span></p></li>
    </ul>
  </b>`;

  it('neutralizes the b-wrapper and maps styles to marks', () => {
    const blocks = htmlToBlocks(html);
    expect(types(blocks)).toEqual(['paragraph', 'heading', 'bulleted_list_item', 'bulleted_list_item']);
    const p = blocks[0]!;
    expect(plainText(p.text)).toBe('Un paragraphe gras et italique.');
    const boldRun = p.text!.find((r) => r.text === 'gras')!;
    expect(boldRun.marks?.map((m) => m.type)).toEqual(['bold']);
    const italicRun = p.text!.find((r) => r.text === 'italique')!;
    expect(italicRun.marks?.map((m) => m.type)).toEqual(['italic']);
    // the font-weight:normal wrapper must NOT have produced a document-wide bold
    expect(marksOf(p, 0)).toEqual([]);
    expect(blocks[1]!.props?.['level']).toBe(2);
    expect(texts(blocks.slice(2))).toEqual(['premier', 'second']);
  });
});

describe('paste: Microsoft Word', () => {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
  <body lang=FR style='tab-interval:35.4pt'>
  <p class=MsoNormal>Premier paragraphe Word.<o:p></o:p></p>
  <p class=MsoNormal><b style='mso-bidi-font-weight:normal'>Gras Word</b> et <i>italique</i>.<o:p></o:p></p>
  <h1><span lang=FR>Titre Word</span></h1>
  <p class=MsoListParagraph style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span>Puce Word</p>
  </body></html>`;

  it('parses paragraphs, marks and headings; mso-list stays a paragraph (documented limit)', () => {
    const blocks = htmlToBlocks(html);
    expect(types(blocks)).toEqual(['paragraph', 'paragraph', 'heading', 'paragraph']);
    expect(texts(blocks)[0]).toBe('Premier paragraphe Word.');
    const p2 = blocks[1]!;
    expect(p2.text!.find((r) => r.text === 'Gras Word')!.marks?.map((m) => m.type)).toEqual(['bold']);
    expect(blocks[2]!.props?.['level']).toBe(1);
    // ponytail: Word fake-lists (MsoListParagraph) are not detected as list items yet;
    // the bullet glyph run is kept so no content is lost
    expect(texts(blocks)[3]).toContain('Puce Word');
  });
});

describe('paste: Excel / spreadsheet table', () => {
  const html = `<table border=0 cellpadding=0 cellspacing=0 width=192>
    <tr height=21><td height=21 width=64>Nom</td><td width=64>Qté</td><td width=64>Prix</td></tr>
    <tr height=21><td height=21>Pomme</td><td align=right>3</td><td align=right>2,50</td></tr>
  </table>`;

  const grid = (block: { children?: { children?: { text?: { text: string }[] }[] }[] }) =>
    (block.children ?? []).map((r) => (r.children ?? []).map((c) => (c.text ?? []).map((t) => t.text).join('')));

  it('becomes a real table block', () => {
    const [block] = htmlToBlocks(html);
    expect(block!.type).toBe('table');
    expect(grid(block!)).toEqual([
      ['Nom', 'Qté', 'Prix'],
      ['Pomme', '3', '2,50'],
    ]);
    // Excel emits <td> everywhere, so nothing claims to be a header
    expect(block!.props?.['headerRow']).toBe(false);
  });

  it('keeps the header when the source marks one with <th>', () => {
    const [block] = htmlToBlocks('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(block!.props?.['headerRow']).toBeUndefined();
  });
});

describe('paste: TSV without an HTML flavour', () => {
  it('turns an aligned tab grid into a table', () => {
    const block = tsvToTable('Nom\tVille\nAda\tLondres');
    expect(block!.type).toBe('table');
    expect(block!.children).toHaveLength(2);
  });

  it('leaves prose alone when the tab counts disagree', () => {
    expect(tsvToTable('a\tb\nc')).toBeNull();
    expect(tsvToTable('une seule ligne\tavec tab')).toBeNull();
    expect(tsvToTable('pas de tab\ndu tout')).toBeNull();
  });
});

describe('paste: VS Code', () => {
  const html = `<div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;"><div><span style="color: #569cd6;">const</span><span style="color: #d4d4d4;"> x = </span><span style="color: #b5cea8;">42</span><span style="color: #d4d4d4;">;</span></div></div>`;

  it('keeps the code text (language detection via vscode-editor-data is the paste pipeline, not html)', () => {
    const blocks = htmlToBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(plainText(blocks[0]!.text)).toBe('const x = 42;');
  });
});

describe('paste: generic web content', () => {
  it('maps semantic tags to blocks and inline marks', () => {
    const blocks = htmlToBlocks(
      `<h3>Section</h3>
       <p>Un lien <a href="https://example.com">exemple</a> et du <code>code</code>, du <s>barré</s>.</p>
       <blockquote>Une citation.</blockquote>
       <pre><code>fenced()</code></pre>
       <hr>
       <img src="https://example.com/a.png">
       <ol><li>un<ul><li>imbriqué</li></ul></li><li>deux</li></ol>`,
    );
    expect(types(blocks)).toEqual([
      'heading',
      'paragraph',
      'quote',
      'code',
      'divider',
      'image',
      'numbered_list_item',
      'numbered_list_item',
    ]);
    const p = blocks[1]!;
    const link = p.text!.find((r) => r.text === 'exemple')!;
    expect(link.marks?.[0]).toEqual({ type: 'link', attrs: { href: 'https://example.com' } });
    expect(p.text!.find((r) => r.text === 'code')!.marks?.map((m) => m.type)).toEqual(['code']);
    expect(p.text!.find((r) => r.text === 'barré')!.marks?.map((m) => m.type)).toEqual(['strike']);
    const nested = blocks[6]!;
    expect(nested.children?.map((c) => c.type)).toEqual(['bulleted_list_item']);
    expect(blocks[5]!.props?.['src']).toBe('https://example.com/a.png');
  });

  it('normalizes nbsp and <br> to spaces and newlines', () => {
    const blocks = htmlToBlocks('<p>mot&nbsp;collé<br>suite</p>');
    expect(plainText(blocks[0]!.text)).toBe('mot collé\nsuite');
  });

  it('ignores empty containers and scripts-free junk wrappers', () => {
    const blocks = htmlToBlocks('<div><div><section><p>seul</p></section><div>   </div></div></div>');
    expect(types(blocks)).toEqual(['paragraph']);
    expect(texts(blocks)).toEqual(['seul']);
  });
});
