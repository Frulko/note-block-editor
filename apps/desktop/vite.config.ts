import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * Tauri serves this over its own protocol and watches `src-tauri` itself.
 *
 * The two plugins are for Loro: its WASM loader uses a top-level `await` and an
 * ESM WASM import, which Vite's production path handles and its dev path does
 * not. `tauri dev` is the dev path, so without them the app builds and will not
 * run — the failure that looks like success.
 */
export default defineConfig({
  clearScreen: false,
  plugins: [wasm(), topLevelAwait()],
  server: { port: 5174, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
