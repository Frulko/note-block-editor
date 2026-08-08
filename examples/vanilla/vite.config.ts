import { defineConfig } from 'vite';

// the demo uses top-level await, which the default browser targets reject
export default defineConfig({ build: { target: 'esnext' } });
