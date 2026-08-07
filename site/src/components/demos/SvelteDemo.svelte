<script lang="ts">
  import { blockEditor } from '@nbe/svelte';

  const seed = {
    id: 's-root',
    type: 'page',
    version: 1,
    children: [
      { id: 's-1', type: 'heading', version: 1, props: { level: 3 }, text: [{ text: 'Svelte' }] },
      { id: 's-2', type: 'paragraph', version: 1, text: [{ text: 'Une action, pas un composant — la forme idiomatique.' }] },
    ],
  };
</script>

<div use:blockEditor={{ initialContent: seed, maxWidth: '100%', padding: { top: '16px', bottom: '24px', x: '18px' } }}></div>
