#!/usr/bin/env node
import { blocksToMarkdown } from '@nbe/markdown';
import { checkReadable, importDirectory, openWorkspace, writeVault } from './index';
import { watchVault } from './watch';

/**
 * `nbe` — a workspace on the command line.
 *
 * @remarks
 * The point of this is not convenience. §10 promises that deleting the app
 * leaves a readable workspace, and until now that promise had no runtime where
 * files were real enough to test it. `nbe check` is that test, and it runs in
 * CI (`packages/cli/test/acceptance.test.ts`).
 *
 * Argument parsing is by hand — twenty lines against a dependency that every
 * consumer would then carry, for a tool whose grammar is `nbe <verb> [args]`.
 *
 * @category CLI
 */

const USAGE = `nbe — un espace de travail en Markdown

  nbe ls                    l'arbre des pages
  nbe new <titre> [--parent <id>]
  nbe cat <id>              une page, en Markdown
  nbe search <requête>
  nbe sync                  régénère le miroir Markdown depuis les pages
  nbe import <dossier>      un vault ou un export Notion
  nbe watch                 reprend les modifications faites dans un autre éditeur
  nbe check                 vérifie que tout est lisible sans cet outil

  --root <dossier>          l'espace de travail (défaut : le dossier courant)
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i] ?? '';
    else positional.push(arg);
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parse(argv);
  const root = flags['root'] ?? process.cwd();

  if (command === 'help' || flags['help'] !== undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  const workspace = await openWorkspace(root);

  switch (command) {
    case 'ls': {
      const line = (id: string, depth: number): void => {
        const node = workspace.node(id);
        if (!node) return;
        process.stdout.write(`${'  '.repeat(depth)}${node.title}  ${node.id}\n`);
        for (const child of node.children) line(child, depth + 1);
      };
      for (const id of workspace.roots) line(id, 0);
      return 0;
    }

    case 'new': {
      const title = positional.join(' ');
      if (!title) return fail('nbe new <titre>');
      const id = await workspace.createPage({ title, parentId: flags['parent'] ?? null });
      writeVault(workspace, root);
      process.stdout.write(`${id}\n`);
      return 0;
    }

    case 'cat': {
      const id = positional[0];
      const doc = id ? workspace.document(id) : null;
      if (!doc) return fail(`page introuvable : ${id ?? '(aucune)'}`);
      process.stdout.write(blocksToMarkdown(doc.children ?? []) + '\n');
      return 0;
    }

    case 'search': {
      const hits = workspace.search(positional.join(' '));
      for (const hit of hits) process.stdout.write(`${hit.title}\n  ${hit.snippet}\n  ${hit.pageId}\n`);
      return hits.length ? 0 : 1;
    }

    case 'sync': {
      const written = writeVault(workspace, root);
      process.stdout.write(`${written.length} fichier(s) écrit(s)\n`);
      return 0;
    }

    case 'import': {
      const from = positional[0];
      if (!from) return fail('nbe import <dossier>');
      const count = await importDirectory(workspace, from);
      writeVault(workspace, root);
      process.stdout.write(`${count} page(s) importée(s)\n`);
      return 0;
    }

    case 'watch': {
      process.stdout.write(`surveillance de ${root}/vault — Ctrl+C pour arrêter\n`);
      watchVault(workspace, root, {
        onImport: (paths, pages) =>
          process.stdout.write(`↻ ${paths.length} fichier(s) modifié(s), ${pages} page(s) à jour\n`),
        onMissing: (paths) =>
          process.stderr.write(`? ${paths.length} fichier(s) disparu(s), pages conservées : ${paths.join(', ')}\n`),
      });
      // the watcher unrefs its timer, so hold the process open deliberately
      await new Promise(() => {});
      return 0;
    }

    case 'check': {
      const problems = checkReadable(workspace, root);
      for (const problem of problems) process.stderr.write(`✗ ${problem}\n`);
      if (!problems.length) {
        process.stdout.write(`✓ ${workspace.pages.length} page(s) lisibles sans cet outil\n`);
      }
      return problems.length ? 1 : 0;
    }

    default:
      return fail(`commande inconnue : ${command}\n\n${USAGE}`);
  }
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
