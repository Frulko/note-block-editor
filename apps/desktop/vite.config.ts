import { defineConfig } from 'vite';

// Tauri serves this over its own protocol and watches src-tauri itself
export default defineConfig({
  clearScreen: false,
  server: { port: 5174, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'esnext' },
});
