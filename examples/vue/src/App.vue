<script setup lang="ts">
import { ref } from 'vue';
import { BlockEditor } from '@nbe/vue';
import type { BlockJSON } from '@nbe/core';
import { uuidv7 } from '@nbe/core';
import { renderToHTML } from '@nbe/static-renderer';

const initialContent: BlockJSON = {
  id: uuidv7(),
  type: 'page',
  version: 1,
  children: [
    { id: uuidv7(), type: 'heading', version: 1, props: { level: 1 }, text: [{ text: 'Éditeur dans Vue' }] },
    {
      id: uuidv7(),
      type: 'paragraph',
      version: 1,
      text: [
        { text: 'Le même cœur ' },
        { text: 'vanilla', marks: [{ type: 'bold' }] },
        { text: ' que dans React et Svelte : seul le montage change.' },
      ],
    },
    { id: uuidv7(), type: 'to_do', version: 1, props: { checked: false }, text: [{ text: 'Taper "/" pour le menu' }] },
    {
      id: uuidv7(),
      type: 'callout',
      version: 1,
      props: { icon: '💚' },
      text: [{ text: 'Le panneau de droite est le rendu statique, sans instance d’éditeur.' }],
    },
    { id: uuidv7(), type: 'paragraph', version: 1, text: [] },
  ],
};

const doc = ref<BlockJSON>(initialContent);
const tab = ref<'html' | 'json'>('html');
const onChange = (next: BlockJSON) => {
  doc.value = next;
};
</script>

<template>
  <div class="app">
    <header><strong>notion-block-editor</strong> <span class="tag">Vue</span></header>
    <main>
      <div class="pane editor-pane">
        <BlockEditor class="page" :initial-content="initialContent" @change="onChange" />
      </div>
      <aside class="pane inspector">
        <nav>
          <button :class="{ active: tab === 'html' }" @click="tab = 'html'">Rendu statique</button>
          <button :class="{ active: tab === 'json' }" @click="tab = 'json'">Document</button>
        </nav>
        <div v-if="tab === 'html'" class="static-preview" v-html="renderToHTML(doc)" />
        <pre v-else>{{ JSON.stringify(doc, null, 2) }}</pre>
      </aside>
    </main>
  </div>
</template>
