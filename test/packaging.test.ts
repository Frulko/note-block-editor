import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Packaging invariants (ARCHITECTURE §9). These are CI-enforced rather than
 * review-enforced: layering rot is invisible in a diff but fatal to the
 * "headless core, one DOM view, thin mounts" promise.
 */

const root = join(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir);

const manifest = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8'));

const deps = (name: string): string[] => Object.keys((manifest(name)['dependencies'] as object) ?? {});

describe('package layering', () => {
  it('core has no runtime dependencies (headless, zero DOM)', () => {
    expect(deps('core')).toEqual([]);
  });

  it.each(['markdown', 'static-renderer'])(
    'projection package %s depends on core only, never on dom',
    (name) => {
      expect(deps(name)).toEqual(['@nbe/core']);
    },
  );

  it('collab depends on core and the CRDT, nothing else', () => {
    expect(deps('collab').sort()).toEqual(['@nbe/core', 'loro-crdt']);
  });

  it('the cli depends on core, markdown, workspace and collab — and no framework', () => {
    // `ws` because Node ships a WebSocket *client* and no server, and the
    // handshake plus framing is a protocol rather than a few lines.
    // `collab` because `nbe serve` is a *peer*: it runs the same `connect()`
    // as every client rather than reimplementing sync inside the relay.
    // `node-datachannel` because Node has no `RTCPeerConnection` and `nbe peer`
    // needs a real one — and this is the layer allowed to have it, precisely so
    // that `collab` stays at core+CRDT and every client injects its own.
    // `@nbe/blocks-table` because a block type is only in a projection if its
    // plugin is registered: the CLI is a *host* and has to name its block set,
    // exactly like an app mounting an editor.
    expect(deps('cli').sort()).toEqual([
      '@nbe/blocks-code',
      '@nbe/blocks-table',
      '@nbe/blocks-toc',
      '@nbe/collab',
      '@nbe/core',
      '@nbe/markdown',
      '@nbe/workspace',
      'node-datachannel',
      'ws',
    ]);
  });

  it('workspace depends on core and markdown (the vault is a markdown projection)', () => {
    expect(deps('workspace').sort()).toEqual(['@nbe/core', '@nbe/markdown']);
  });

  it('dom depends only on core and markdown (clipboard needs the md projection)', () => {
    expect(deps('dom').sort()).toEqual(['@nbe/core', '@nbe/markdown']);
  });

  it.each([
    ['react', 'react'],
    ['vue', 'vue'],
    ['svelte', 'svelte'],
  ])('binding %s is thin: deps are exactly core+dom, framework is a peer', (name, framework) => {
    // a third dependency means the feature belongs one layer down
    expect(deps(name).sort()).toEqual(['@nbe/core', '@nbe/dom']);
    const peers = Object.keys((manifest(name)['peerDependencies'] as object) ?? {});
    expect(peers).toEqual([framework]);
  });
});

describe('block plugin packages', () => {
  const pluginPackages = packages.filter((name) => name.startsWith('blocks-'));

  it('there is at least one, or these invariants are theatre', () => {
    expect(pluginPackages.length).toBeGreaterThan(0);
  });

  it.each(pluginPackages)('%s keeps @nbe/dom a peer, never a dependency', (name) => {
    // the model half must load in a CLI, a server and a native port; a hard
    // dependency on the view would make that impossible for every consumer
    expect(deps(name)).not.toContain('@nbe/dom');
    expect(Object.keys((manifest(name)['peerDependencies'] as object) ?? {})).toContain('@nbe/dom');
  });

  it.each(pluginPackages)('%s exports a model entry and a /dom entry', (name) => {
    const exports = manifest(name)['exports'] as Record<string, unknown>;
    expect(Object.keys(exports)).toEqual(expect.arrayContaining(['.', './dom']));
  });

  it.each(pluginPackages)('%s: only its /dom half imports @nbe/dom', (name) => {
    const dir = join(packagesDir, name, 'src');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      const importsDom = /from '@nbe\/dom'/.test(source.replace(/\/\*[\s\S]*?\*\//g, ''));
      // `index.ts` is what @nbe/markdown and @nbe/static-renderer consume
      const modelHalf = file !== 'dom.ts' && !/^(chrome|select|styles|paint)\.ts$/.test(file);
      if (modelHalf) expect([file, importsDom]).toEqual([file, false]);
    }
  });
});

describe('package manifests', () => {
  it.each(packages)('%s is ESM-only, side-effect free and exports its entry', (name) => {
    const pkg = manifest(name);
    expect(pkg['type']).toBe('module');
    expect(pkg['exports']).toBeTruthy();
    // dom ships style.css, everything else must be side-effect free
    if (name === 'dom') expect(pkg['sideEffects']).toEqual(['*.css']);
    else expect(pkg['sideEffects']).toBe(false);
  });

  it('every package is scoped @nbe/<dir>', () => {
    for (const name of packages) expect(manifest(name)['name']).toBe(`@nbe/${name}`);
  });
});

describe('source layering', () => {
  const sourceFiles = (name: string): string[] => {
    const dir = join(packagesDir, name, 'src');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : [],
      );
    return walk(dir);
  };

  /**
   * Real import/export specifiers only.
   *
   * Comments are stripped first, which is not fussiness: a doc `@example`
   * showing how to import the package would otherwise read as the package
   * importing itself, and an example that cannot show an import is useless.
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const importsOf = (source: string): string[] =>
    [...stripComments(source).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

  it('core never imports a sibling package', () => {
    for (const file of sourceFiles('core')) {
      expect(importsOf(readFileSync(file, 'utf8')).filter((s) => s.startsWith('@nbe/'))).toEqual([]);
    }
  });

  it.each(['markdown', 'static-renderer', 'workspace'])('%s never imports @nbe/dom', (name) => {
    for (const file of sourceFiles(name)) {
      expect(importsOf(readFileSync(file, 'utf8'))).not.toContain('@nbe/dom');
    }
  });

  /**
   * English is what an editor ships with; every other language is opt-in.
   *
   * @remarks
   * Measured with esbuild on a bundle holding the whole editor: an app that
   * never mentions a language is 198.9 kB and contains only English, naming
   * `fr` costs 4.5 kB more, and calling `labelsFor()` costs 17.5 — because
   * reading a system locale at runtime means the answer is not known at build
   * time and every pack has to be there.
   *
   * The first of those is what stops being true by accident. It holds for one
   * reason only: nothing on the default path *references* `LOCALES` or a pack,
   * so a bundler can drop the four unused ones. Wire `labelsFor` into the view
   * — a reasonable-looking convenience — and all five become reachable, the
   * editor gets 17.5 kB heavier for every host, and no diff says so. Checking
   * the reference is cheaper than checking the bundle, and does not put a
   * bundler in the test dependencies for one assertion.
   */
  it('only English is on the default path — the other packs stay droppable', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('dom')) {
      if (file.includes(`${sep}i18n${sep}`)) continue; // the packs' own module
      /*
       * Re-exports are struck out first, and that is the whole distinction: a
       * `export { LOCALES } from './i18n'` names the packs without *using*
       * them, which is exactly the shape a bundler can drop. An `import` on
       * this side of the arrow is what makes one part of the default path.
       */
      const source = stripComments(readFileSync(file, 'utf8')).replace(/export\s*(\{[^}]*\}|\*)\s*from[^;]+;/g, '');
      const where = file.split(`${sep}src${sep}`)[1];
      if (/import\s[^;]*\bfrom\s*['"][^'"]*i18n(?:\/index)?['"]/.test(source)) {
        offenders.push(`${where} imports from ./i18n`);
      }
      if (/\bLOCALES\b/.test(source)) offenders.push(`${where} references LOCALES`);
    }
    expect(offenders).toEqual([]);

    // and the default really is English, not merely "not French"
    const labels = readFileSync(join(packagesDir, 'dom', 'src', 'labels.ts'), 'utf8');
    expect(labels).toMatch(/export const defaultLabels: EditorLabels = en;/);
  });

  /**
   * The emoji catalogues are a host's choice, never the editor's.
   *
   * @remarks
   * The same rule as the language packs above, for a hundred times the weight:
   * `@nbe/emoji` is five generated modules of ~110 kB, one per language, and
   * the editor ships a curated two dozen instead. One `import` from `src/`
   * would put a catalogue in every bundle that holds the editor — and it is
   * exactly the import that looks harmless, because it makes the picker better
   * for free. It does not: `emojis` is an option, and the host names it.
   */
  it('the emoji catalogues stay a host\'s choice — the editor imports none', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('dom')) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (/from\s*['"]@nbe\/emoji/.test(source)) offenders.push(file.split(`${sep}src${sep}`)[1]!);
    }
    expect(offenders).toEqual([]);
  });

  it('core touches no DOM globals (server/CLI/native portability)', () => {
    // comments stripped for the same reason as the import check: prose ends a
    // sentence with "the document." and that is not a DOM global
    for (const file of sourceFiles('core')) {
      expect(stripComments(readFileSync(file, 'utf8'))).not.toMatch(
        /\bdocument\.|\bwindow\.|HTMLElement/,
      );
    }
  });
});

describe('R7: the three bindings agree on one option contract', () => {
  /** The members an interface declares beyond what it extends. */
  function members(source: string, name: string): string[] {
    const body = new RegExp(`export interface ${name} extends EditorViewOptions \\{([\\s\\S]*?)\\n\\}`).exec(source);
    if (!body) throw new Error(`${name} should extend EditorViewOptions`);
    return [...body[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]!).sort();
  }

  it('all three extend EditorViewOptions and add exactly the same members', () => {
    /*
     * The plan's own finding: React spread the options as props, Vue nested
     * them under an `options` prop and Svelte took them in an action argument —
     * three shapes for one contract, in packages whose whole promise is being
     * interchangeable thin mounts. The docs could not state one rule.
     *
     * The *shape* of the mount is allowed to differ, because that is the
     * framework's idiom. The option contract is not.
     */
    const read = (pkg: string) => readFileSync(join(__dirname, '..', 'packages', pkg, 'src', 'index.ts'), 'utf8');
    const react = members(read('react'), 'UseEditorOptions');
    const vue = members(read('vue'), 'UseEditorOptions');
    const svelte = members(read('svelte'), 'BlockEditorActionOptions');

    expect(react).toEqual(['initialContent', 'onChange', 'onReady']);
    expect(vue).toEqual(react);
    expect(svelte).toEqual(react);
  });
});
