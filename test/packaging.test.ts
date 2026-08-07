import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('the cli depends on core, markdown and workspace — and no framework', () => {
    expect(deps('cli').sort()).toEqual(['@nbe/core', '@nbe/markdown', '@nbe/workspace']);
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
