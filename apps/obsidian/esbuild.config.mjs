import esbuild from 'esbuild';

/**
 * Obsidian loads one CommonJS file and provides `obsidian` itself, so the
 * bundle is everything except that. Our packages are bundled in — the plugin
 * is distributed as a file a user drops in a folder, not as an npm install.
 */
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron'],
  format: 'cjs',
  target: 'es2020',
  outfile: 'main.js',
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  minify: !process.argv.includes('--watch'),
  logLevel: 'info',
});

if (process.argv.includes('--watch')) await context.watch();
else {
  await context.rebuild();
  await context.dispose();
}
