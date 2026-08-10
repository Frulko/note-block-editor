import { spawn } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

/**
 * `pnpm dev` starts the relay too, because a demo about several people needs
 * one and a second terminal is a step nobody remembers.
 *
 * @remarks
 * It is the CLI's relay — the one `nbe relay` runs and the one the e2e suite
 * uses — spawned, not reimplemented. It shares this process group, so Ctrl+C
 * takes both down. Already listening (another `pnpm dev`, or a relay you
 * started yourself)? It says so and the page uses that one.
 *
 * ponytail: fixed port 8787, matching the client's default. Pass `?relay=…`
 * to point the page somewhere else.
 */
const relay = (): Plugin => ({
  name: 'demo-relay',
  apply: 'serve',
  configureServer() {
    const child = spawn('pnpm', ['--filter', '@nbe/cli', 'exec', 'tsx', 'src/bin.ts', 'relay'], {
      stdio: 'ignore',
    });
    child.on('error', (error) => console.error('[relais] impossible à démarrer :', error.message));
    child.on('exit', (code) => {
      if (code) console.error('[relais] arrêté — un autre écoute déjà sur 8787 ? la page utilisera celui-là.');
    });
    process.on('exit', () => child.kill());
  },
});

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
  plugins: [wasm(), topLevelAwait(), relay()],
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  build: { target: 'esnext' },
});
