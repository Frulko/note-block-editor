/**
 * Print accurate Lucide paths, to paste into `packages/dom/src/ui/icons.ts`.
 *
 * @remarks
 * The icon set is hand-maintained and inlined on purpose — @nbe/dom's empty
 * runtime dependency list is a CI-enforced invariant. This only exists so the
 * paths are *copied* from the real thing rather than drawn from memory, which
 * is how an icon ends up subtly wrong. lucide-static is a dev dependency.
 *
 * Usage: node scripts/build-icons.mjs file-text database pilcrow
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every icon the UI uses. Keep sorted; keep it honest — unused shapes are weight. */
const WANTED = process.argv.slice(2);

/** The inner shapes of a lucide icon, whitespace collapsed. */
function body(name) {
  const svg = readFileSync(join(root, 'node_modules/lucide-static/icons', `${name}.svg`), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
  return inner.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

for (const name of WANTED) {
  console.log(`  '${name}': '${body(name).replace(/'/g, "\\'")}',`);
}
