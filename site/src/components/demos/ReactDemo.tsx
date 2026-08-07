import { BlockEditor } from '@nbe/react';

/** The React binding, actually running — not a screenshot. */
export default function ReactDemo() {
  return <BlockEditor initialContent={seed} maxWidth="100%" padding={{ top: '16px', bottom: '24px', x: '18px' }} />;
}

const seed = {
  id: 'r-root',
  type: 'page',
  version: 1,
  children: [
    { id: 'r-1', type: 'heading', version: 1, props: { level: 3 }, text: [{ text: 'React' }] },
    { id: 'r-2', type: 'paragraph', version: 1, text: [{ text: 'Tapez ' }, { text: '/', marks: [{ type: 'code' }] }, { text: ' pour ouvrir le menu de blocs.' }] },
  ],
};
