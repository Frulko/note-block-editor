// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import vue from '@astrojs/vue';
import svelte from '@astrojs/svelte';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * Astro is the point of this site, not an incidental choice: the three
 * framework bindings each get a *running* island on the same page, which is
 * the one thing a React-only app framework could not do. Everything else is
 * static content, shipping no JavaScript unless an island asks for it.
 */
export default defineConfig({
  site: 'https://frulko.github.io',
  // GitHub Pages sert le site sous /carnet/ ; en local, pas de base.
  base: process.env.BASE_PATH,
  integrations: [mdx(), react(), vue(), svelte()],
  markdown: {
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, wrap: true },
  },
  vite: {
    /**
     * Loro ships as WebAssembly with a top-level `await` in its loader. Vite's
     * production path handles neither without these, and the collaborative
     * island is the only thing on the site that needs a CRDT — so it is the
     * island, not the site, that pays: `client:only` keeps the WASM out of
     * every other page's bundle.
     */
    plugins: [wasm(), topLevelAwait()],
    build: { target: 'esnext' },
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
    ssr: {
      /**
       * The editor packages export `src/*.ts` with extensionless relative
       * imports — fine for a bundler, but Node's ESM loader refuses them, and
       * Astro renders islands through Node on the server. Running them through
       * Vite's transform instead of externalising fixes it.
       *
       * This is the monorepo-consuming-source workaround. The real fix is the
       * build step those packages still lack; see the publish-tooling note in
       * docs/ROADMAP.md.
       */
      noExternal: [
        '@nbe/core',
        '@nbe/dom',
        '@nbe/markdown',
        '@nbe/react',
        '@nbe/vue',
        '@nbe/svelte',
        '@nbe/collab',
      ],
    },
  },
});
