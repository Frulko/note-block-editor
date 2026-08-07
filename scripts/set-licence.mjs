/**
 * Write the licence and repository across every package, once they are chosen.
 *
 * @remarks
 * Eleven packages need the same four fields and the root needs a `LICENSE`
 * file. Doing that by hand is eleven chances to write something slightly
 * different, and the survey's clearest licensing lesson
 * (`docs/research/competitive-landscape.md`) is that a project whose stated
 * licence and actual licence disagree loses trust it does not get back.
 *
 * It refuses to guess. Both arguments are required, because inventing either a
 * licence or someone's repository URL is the one thing a script must not do.
 *
 * Usage: node scripts/set-licence.mjs MIT https://github.com/you/repo
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [licence, repository] = process.argv.slice(2);

if (!licence || !repository) {
  console.error('usage : node scripts/set-licence.mjs <SPDX> <url-du-dépôt>');
  console.error('exemple : node scripts/set-licence.mjs MIT https://github.com/vous/carnet');
  process.exit(1);
}

/** The one-line summary each package carries, so npm shows something useful. */
const DESCRIPTIONS = {
  '@nbe/core': 'Le modèle de document : blocs, opérations, sélection, historique.',
  '@nbe/dom': "L'éditeur : rendu, saisie, menus, glisser-déposer.",
  '@nbe/markdown': 'La projection lisible : markdown dans les deux sens, CSV, vues de collection.',
  '@nbe/workspace': "L'espace de travail : arbre de pages, vault, bases de données.",
  '@nbe/collab': 'Collaboration : CRDT Loro, synchronisation, présence, commentaires, historique.',
  '@nbe/cli': 'Le vault en ligne de commande, et le nœud de synchronisation.',
  '@nbe/react': 'Liaison React, fine : le travail est dans @nbe/dom.',
  '@nbe/vue': 'Liaison Vue, fine : le travail est dans @nbe/dom.',
  '@nbe/svelte': 'Liaison Svelte, fine : le travail est dans @nbe/dom.',
  '@nbe/static-renderer': 'Rendu statique en HTML, sans DOM.',
  '@nbe/blocks-callout': 'Le bloc encadré, en exemple de greffon.',
};

const author = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).author ?? '';
let touched = 0;

for (const name of readdirSync(join(root, 'packages'))) {
  const path = join(root, 'packages', name, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));

  manifest.license = licence;
  manifest.repository = { type: 'git', url: `git+${repository}.git`, directory: `packages/${name}` };
  manifest.homepage = `${repository}#readme`;
  manifest.bugs = { url: `${repository}/issues` };
  if (author) manifest.author = author;
  if (DESCRIPTIONS[manifest.name]) manifest.description = DESCRIPTIONS[manifest.name];

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  touched++;
}

const YEAR = new Date().getFullYear();
const MIT = `MIT License

Copyright (c) ${YEAR} ${author || '<auteur>'}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

if (licence === 'MIT') {
  writeFileSync(join(root, 'LICENSE'), MIT);
  console.log('LICENSE écrit (MIT)');
} else {
  console.log(`LICENSE non écrit : déposez le texte de ${licence} à la racine vous-même.`);
}

console.log(`${touched} paquets mis à jour → ${licence}, ${repository}`);
