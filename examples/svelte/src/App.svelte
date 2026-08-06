<script lang="ts">
  import { blockEditor } from '@nbe/svelte';
  import { uuidv7, type BlockJSON } from '@nbe/core';
  import { renderToHTML } from '@nbe/static-renderer';

  const initialContent: BlockJSON = {
    id: uuidv7(),
    type: 'page',
    version: 1,
    children: [
      { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: [{ text: 'Éditeur dans Svelte' }] },
      {
        id: uuidv7(),
        type: 'paragraph',
        version: 1,
        text: [
          { text: 'Le binding Svelte est une ' },
          { text: 'action', marks: [{ type: 'code' }] },
          { text: ' : ' },
          { text: 'use:blockEditor', marks: [{ type: 'bold' }] },
          { text: ' — pas de composant compilé, donc le package reste du TS pur.' },
        ],
      },
      { id: uuidv7(), type: 'to_do', version: 1, props: { checked: false }, text: [{ text: 'Taper "/" pour le menu' }] },
      {
        id: uuidv7(),
        type: 'callout',
        version: 1,
        props: { icon: '🧡' },
        text: [{ text: 'Le panneau de droite est le rendu statique, sans instance d’éditeur.' }],
      },
      { id: uuidv7(), type: 'paragraph', version: 1, text: [] },
    ],
  };

  let doc = $state<BlockJSON>(initialContent);
  let tab = $state<'html' | 'json'>('html');
</script>

<div class="app">
  <header><strong>notion-block-editor</strong> <span class="tag">Svelte</span></header>
  <main>
    <div class="pane editor-pane">
      <div class="page" use:blockEditor={{ initialContent, onChange: (next) => (doc = next) }}></div>
    </div>
    <aside class="pane inspector">
      <nav>
        <button class={tab === 'html' ? 'active' : ''} onclick={() => (tab = 'html')}>Rendu statique</button>
        <button class={tab === 'json' ? 'active' : ''} onclick={() => (tab = 'json')}>Document</button>
      </nav>
      {#if tab === 'html'}
        <div class="static-preview">{@html renderToHTML(doc)}</div>
      {:else}
        <pre>{JSON.stringify(doc, null, 2)}</pre>
      {/if}
    </aside>
  </main>
</div>
