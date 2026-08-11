import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    alias: {
      // `obsidian` is a typings-only package — the app supplies the runtime,
      // which is why the plugin bundles it as external. Tests get a stub so an
      // Obsidian-facing module can be imported for the parts of it that are
      // not. See `test/obsidian-stub.ts`.
      obsidian: fileURLToPath(new URL('./test/obsidian-stub.ts', import.meta.url)),
    },
  },
});
