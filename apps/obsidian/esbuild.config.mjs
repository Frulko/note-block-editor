import esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

/**
 * Obsidian loads one CommonJS file plus one stylesheet and provides `obsidian`
 * itself, so the bundle is everything except that. `src/styles.css` @imports
 * the editor's stylesheet, which esbuild inlines — Obsidian only ever loads
 * `styles.css`, so the CSS has to be bundled there, not into main.js.
 *
 * Every build also assembles `dist/carnet/`, the ready-to-drop plugin folder.
 * `--vault <path>` additionally copies it into that vault's plugins directory:
 *
 *   pnpm --filter @nbe/obsidian build --vault ~/Documents/MyVault
 */
const watch = process.argv.includes('--watch');
const vaultFlag = process.argv.indexOf('--vault');
const vault = vaultFlag !== -1 ? process.argv[vaultFlag + 1] : null;

const packageUp = {
  name: 'package-up',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      mkdirSync('dist/carnet', { recursive: true });
      for (const f of ['main.js', 'styles.css', 'manifest.json']) cpSync(f, `dist/carnet/${f}`);
      if (vault) cpSync('dist/carnet', `${vault}/.obsidian/plugins/carnet`, { recursive: true });
      console.log(`→ dist/carnet${vault ? ` → ${vault}/.obsidian/plugins/carnet` : ''}`);
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts', 'src/styles.css'],
  bundle: true,
  external: ['obsidian', 'electron'],
  format: 'cjs',
  target: 'es2020',
  outdir: '.',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  plugins: [packageUp],
});

if (watch) await context.watch();
else {
  await context.rebuild();
  await context.dispose();
}
