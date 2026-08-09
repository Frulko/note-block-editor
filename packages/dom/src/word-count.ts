import { plainText, visibleBlocks } from '@nbe/core';
import type { EditorView } from './view';
import type { EditorFeature } from './features';

/**
 * Words, characters and how long it takes to read them, under the document.
 *
 * @remarks
 * The first thing built on {@link EditorView.slot}, and it exists as much to
 * prove the slot is enough as to count words: a feature, twenty lines, no
 * change to the renderer and no new option. Anything else that belongs beside
 * the document rather than in it — a cover image up top, a reading-progress
 * bar floating over — is the same shape.
 *
 * Opt-in. A counter is a preference, not a default, and the one thing worse
 * than not having it is having it when you are trying to write.
 *
 * @category Interaction
 */

/** 200 words a minute, the figure every reading-time estimate uses. */
const WORDS_PER_MINUTE = 200;

export interface DocumentSize {
  words: number;
  characters: number;
  /** Reading time in minutes, at least 1 once there is anything at all. */
  minutes: number;
}

/** Count the document as a reader sees it: visible blocks, plain text. */
export function documentSize(view: EditorView): DocumentSize {
  let characters = 0;
  let words = 0;
  for (const block of visibleBlocks(view.editor.doc)) {
    const text = plainText(block.text);
    characters += text.length;
    // `split` on a run of whitespace, then drop the empties the ends leave
    words += text.split(/\s+/).filter(Boolean).length;
  }
  return { words, characters, minutes: words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0 };
}

export const wordCountFeature: EditorFeature = {
  name: 'word-count',
  attach(view) {
    const el = view.slot('bottom');
    const line = document.createElement('div');
    line.className = 'nbe-wordcount';
    line.setAttribute('aria-live', 'off'); // a running count must not be spoken
    el.append(line);

    const render = () => {
      const { words, characters, minutes } = documentSize(view);
      line.textContent = view.labels.wordCount
        .replace('{words}', String(words))
        .replace('{characters}', String(characters))
        .replace('{minutes}', String(minutes));
      line.hidden = words === 0;
    };

    render();
    // after the view has repainted, so a count is never one keystroke behind
    const unsubscribe = view.editor.on(() => queueMicrotask(render));
    return () => {
      unsubscribe();
      line.remove();
    };
  },
};
