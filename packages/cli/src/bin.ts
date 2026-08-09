#!/usr/bin/env node
import { join } from 'node:path';
import { blocksToMarkdown } from '@nbe/markdown';
import { tableBlocks } from '@nbe/blocks-table';
import { PluginRegistry } from '@nbe/core';
import { checkReadable, importDirectory, openWorkspace, writeVault } from './index';
import { watchVault } from './watch';
import { WorkspaceIndex } from './index-db';
import { LockedError, withLock } from './lock';
import { startRelay } from './relay';
import { startNode } from './node';
import { startPeer } from './peer';

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
  nbe search <requête>      recherche classée (index SQLite)
  nbe backlinks <id>        ce qui pointe vers une page
  nbe sync                  régénère le miroir Markdown depuis les pages
  nbe import <dossier>      un vault ou un export Notion
  nbe watch                 reprend les modifications faites dans un autre éditeur
  nbe check                 vérifie que tout est lisible sans cet outil
  nbe relay [--port <n>]    relais de synchronisation *et* de signalisation
  nbe serve [--port <n>]    nœud permanent : relaie *et* conserve les documents
  nbe peer --room <nom>     rejoint un salon en pair-à-pair (WebRTC)
            [--relay ws://…] [--no-store]

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

  /*
   * Only writers take the lock. A read has nothing to lose to a concurrent
   * write — it sees the old page or the new one, never a torn one — and making
   * `nbe ls` fail because a watcher is running would be a worse tool.
   */
  const WRITES = new Set(['new', 'import', 'sync', 'watch']);
  const guarded = <T>(run: () => Promise<T> | T): Promise<T> =>
    WRITES.has(command) ? withLock(root, run) : Promise.resolve(run());

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
      return guarded(async () => {
        const id = await workspace.createPage({ title, parentId: flags['parent'] ?? null });
        writeVault(workspace, root);
        process.stdout.write(`${id}\n`);
        return 0;
      });
    }

    case 'cat': {
      const id = positional[0];
      const doc = id ? workspace.document(id) : null;
      if (!doc) return fail(`page introuvable : ${id ?? '(aucune)'}`);
      process.stdout.write(blocksToMarkdown(doc.children ?? [], { plugins: new PluginRegistry().registerAll(tableBlocks) }) + '\n');
      return 0;
    }

    case 'search': {
      /*
       * Rebuilt before every query rather than kept warm. It is derived data
       * over a person's notes — milliseconds — and a stale answer costs more
       * than a rebuild does. It is also the claim §10 makes about L2, run for
       * real on every search rather than asserted once in a test.
       */
      const index = new WorkspaceIndex(root);
      try {
        index.rebuild(workspace);
        const hits = index.search(positional.join(' '));
        for (const hit of hits) process.stdout.write(`${hit.title}\n  ${hit.snippet}\n  ${hit.pageId}\n`);
        return hits.length ? 0 : 1;
      } finally {
        index.close();
      }
    }

    case 'backlinks': {
      const id = positional[0];
      if (!id) return fail('nbe backlinks <id>');
      const index = new WorkspaceIndex(root);
      try {
        index.rebuild(workspace);
        const links = index.backlinks(id);
        for (const link of links) process.stdout.write(`${link.kind}\t${link.title}\t${link.pageId}\n`);
        return links.length ? 0 : 1;
      } finally {
        index.close();
      }
    }

    case 'sync': {
      return guarded(() => {
        const written = writeVault(workspace, root);
        process.stdout.write(`${written.length} fichier(s) écrit(s)\n`);
        return 0;
      });
    }

    case 'import': {
      const from = positional[0];
      if (!from) return fail('nbe import <dossier>');
      return guarded(async () => {
        const count = await importDirectory(workspace, from);
        writeVault(workspace, root);
        process.stdout.write(`${count} page(s) importée(s)\n`);
        return 0;
      });
    }

    case 'watch': {
      return guarded(async () => {
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
      });
    }

    case 'relay': {
      const relay = await startRelay({
        port: Number(flags['port'] ?? 8787),
        onChange: (room, peers) => process.stdout.write(`${room} : ${peers} pair(s)\n`),
      });
      process.stdout.write(`relais sur ws://localhost:${relay.port} — Ctrl+C pour arrêter\n`);
      await new Promise(() => {});
      return 0;
    }

    case 'serve': {
      /*
       * The difference from `relay` in one line: this one is also a peer, so a
       * client that connects to a room nobody else is in still gets the
       * document. That is what makes it useful on a NAS.
       */
      const node = await startNode({
        port: Number(flags['port'] ?? 8787),
        dir: join(root, '.nbe', 'rooms'),
        onChange: (room, peers) => process.stdout.write(`${room} : ${peers} pair(s)\n`),
        onSave: (room, bytes) => process.stdout.write(`${room} : ${bytes} o enregistrés\n`),
      });
      process.stdout.write(`nœud sur ws://localhost:${node.port} — Ctrl+C pour arrêter\n`);
      await new Promise(() => {});
      return 0;
    }

    case 'peer': {
      const name = flags['room'] ?? positional[0];
      if (!name) return fail('nbe peer --room <nom> [--relay ws://…]');
      const peer = startPeer({
        relay: flags['relay'] ?? 'ws://localhost:8787',
        room: name,
        dir: flags['no-store'] !== undefined ? undefined : join(root, '.nbe', 'rooms'),
        onConnect: (attempt) =>
          process.stdout.write(attempt === 1 ? `connexion au relais…\n` : `reconnexion (essai ${attempt})…\n`),
        onState: ({ peers, direct, relayed }) =>
          process.stdout.write(`${peers} pair(s), ${direct} en direct — ${relayed ? 'via le relais' : 'pair-à-pair'}\n`),
        onSave: (bytes) => process.stdout.write(`${bytes} o enregistrés\n`),
      });
      process.stdout.write(`salon « ${name} » — Ctrl+C pour arrêter\n`);
      process.on('SIGINT', () => {
        peer.stop();
        process.exit(0);
      });
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
    // a busy workspace is a normal outcome, not a crash: say so and exit 3 so
    // a script can retry rather than treating it as a broken command
    if (err instanceof LockedError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
