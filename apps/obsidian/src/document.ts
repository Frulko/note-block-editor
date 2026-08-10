import { PluginRegistry, uuidv7, type BlockJSON } from '@nbe/core';
import { builtinBlocks } from '@nbe/dom';
import { markdownToBlocks } from '@nbe/markdown';
import { tableDomBlocks } from '@nbe/blocks-table/dom';
import { code } from '@nbe/blocks-code/dom';
import { toc } from '@nbe/blocks-toc/dom';
import { dropZone } from '@nbe/blocks-dropzone/dom';
import { embed } from '@nbe/blocks-embed/dom';
import { applyAnchors } from './comments';

/**
 * What a note is made of, on both sides of the projection.
 *
 * @module
 */

/**
 * The blocks the view renders and the projections a note is parsed and written
 * with — one list, read by both. They used to be two, and the table of
 * contents was in only one of them: it rendered fine, was written as an
 * `<!-- nbe:table_of_contents -->` marker on save, and came back as that
 * literal text on the next open. A plugin registered on one side only is
 * always that bug, so there is now no side to forget.
 */
export const BLOCKS = [...builtinBlocks, code, toc, dropZone, embed, ...tableDomBlocks];

export const MARKDOWN_PLUGINS = new PluginRegistry().registerAll(BLOCKS);

/** A page document wrapping freshly parsed blocks. */
export function pageOf(markdown: string, threadIds?: ReadonlySet<string>): BlockJSON {
  return {
    id: uuidv7(),
    type: 'page',
    version: 1,
    props: {},
    children: applyAnchors(markdownToBlocks(markdown, { plugins: MARKDOWN_PLUGINS }), threadIds),
  };
}
