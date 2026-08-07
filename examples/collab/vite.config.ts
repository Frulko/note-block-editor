import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * Running a CRDT in a browser, which costs two plugins and one target.
 *
 * @remarks
 * Loro ships as WebAssembly with an ESM loader that uses a top-level `await`.
 * Vite's production path (Rollup) handles both; its dev path does not — the
 * dependency pre-bundler targets es2020, which predates top-level await, and
 * Vite declines to resolve an ESM WASM import without a plugin. So the demo
 * built and would not run, which is the worst of the two failures because it
 * looks like it works.
 *
 * This lives here rather than at the repo root because this is the app with
 * the dependency: the single-player demo has no CRDT and should not pay for
 * one.
 */
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  build: { target: 'esnext' },
});
