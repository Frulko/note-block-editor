<script setup lang="ts">
import { BlockEditor } from '@nbe/vue';

// note: the Vue binding nests view options under an `options` prop, while the
// React one spreads them. That inconsistency is recorded in the refactor plan.
const options = { maxWidth: '100%', padding: { top: '16px', bottom: '24px', x: '18px' } };

const seed = {
  id: 'v-root',
  type: 'page',
  version: 1,
  children: [
    { id: 'v-1', type: 'heading', version: 1, props: { level: 3 }, text: [{ text: 'Vue' }] },
    { id: 'v-2', type: 'paragraph', version: 1, text: [{ text: 'Le même éditeur, monté par la liaison Vue.' }] },
  ],
};
</script>

<template>
  <BlockEditor :initial-content="seed" :options="options" />
</template>
