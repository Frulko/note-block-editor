import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Workspace, referencedAssets } from '@nbe/workspace';
import { exportVault, importVault, type VaultFile } from '@nbe/workspace/vault';
import { importNotion } from '@nbe/workspace/notion';
import { fileStorage } from './storage';

export { fileStorage } from './storage';

/**
 * A workspace on disk: canonical JSON, mirrored to a Markdown vault.
 *
 * @remarks
 * ROADMAP phase 4b. §10's authority flow, made literal — the editor writes L0,
 * L1 is regenerated from it, and exactly one of them is input at any instant.
 * Here L0 is `.nbe/<id>.json` and L1 is the Markdown tree beside it.
 *
 * The direction matters and is easy to get backwards. Markdown is a projection
 * with documented losses (D7): it cannot express an empty block, and folding a
 * hand-wrapped paragraph is deliberate. If the vault were canonical those
 * losses would compound on every save. So the vault is written *to* and read
 * *from* only on an explicit import, which is the moment a person says "I
 * edited these files, take them".
 *
 * @category CLI
 */

/** Where the Markdown mirror lives, relative to the workspace root. */
const VAULT = 'vault';

export async function openWorkspace(root: string): Promise<Workspace> {
  const workspace = new Workspace(fileStorage(root));
  await workspace.load();
  return workspace;
}

/** Every file under `dir`, as paths relative to it. */
export function readTree(dir: string): VaultFile[] {
  const out: VaultFile[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const key = relative(dir, path).split(sep).join('/');
      // assets are binary; everything else is text an importer parses
      out.push(
        /\.(md|csv|txt)$/i.test(entry.name)
          ? { path: key, text: readFileSync(path, 'utf8') }
          : { path: key, bytes: new Uint8Array(readFileSync(path)) },
      );
    }
  };
  walk(dir);
  return out;
}

/**
 * Regenerate the Markdown mirror from the canonical pages.
 *
 * @remarks
 * The vault directory is rebuilt rather than patched: a page renamed or moved
 * changes its *path*, and a patch would leave the old file behind as a second
 * copy that the next import would read back as a second page. Rebuilding is
 * also what makes the mirror provably a projection — there is no state in it
 * that L0 does not have.
 *
 * @returns The paths written.
 */
export function writeVault(workspace: Workspace, root: string, assets?: ReadonlyMap<string, Uint8Array>): string[] {
  const target = join(root, VAULT);
  rmSync(target, { recursive: true, force: true });
  const files = exportVault(workspace, assets ? { assets } : {});
  for (const file of files) {
    const path = join(target, ...file.path.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    if (file.bytes) writeFileSync(path, file.bytes);
    else writeFileSync(path, file.text ?? '', 'utf8');
  }
  return files.map((f) => f.path);
}

/**
 * Read a directory of Markdown into the workspace.
 *
 * @param from - A vault this tool wrote, or a Notion export. Which one is
 * decided by looking at the filenames rather than by asking: a Notion export
 * names every file with a 32-character hex id, and nothing else does.
 */
export async function importDirectory(workspace: Workspace, from: string): Promise<number> {
  const files = readTree(from);
  const fromNotion = files.some((f) => /[\s-][0-9a-f]{32}\.(md|csv)$/i.test(f.path));
  const pages = fromNotion ? importNotion(files).pages : importVault(files);
  for (const page of pages) await workspace.save(page.id, page);
  return pages.length;
}

/**
 * Check that the workspace is readable without this tool.
 *
 * @remarks
 * §10's acceptance test, as something a machine runs: every page must exist in
 * the vault as Markdown, that Markdown must carry the page's id so links and
 * anchors survive a text editor, and it must not smuggle the model back in as
 * JSON or HTML. A failure here is the project's central promise breaking, so
 * it reports *what* failed rather than a boolean.
 */
export function checkReadable(workspace: Workspace, root: string): string[] {
  const problems: string[] = [];
  const vault = join(root, VAULT);
  if (!existsDirectory(vault)) return [`no vault at ${vault} — run \`nbe sync\``];

  const files = new Map(readTree(vault).map((f) => [f.path, f.text ?? '']));
  for (const node of workspace.pages) {
    const path = [...files.keys()].find((key) => files.get(key)!.includes(`id: ${node.id}`));
    if (!path) {
      problems.push(`page "${node.title}" (${node.id}) has no file in the vault`);
      continue;
    }
    const text = files.get(path)!;
    if (!text.startsWith('---\n')) problems.push(`${path}: no frontmatter, so its id is lost`);
    if (text.includes('"type":')) problems.push(`${path}: contains a JSON blob`);
    if (/<div|<span/.test(text)) problems.push(`${path}: contains HTML markup`);
  }

  // an asset referred to but not written is a broken image for every reader
  const documents = workspace.pages.map((n) => workspace.document(n.id)!).filter(Boolean);
  for (const ref of referencedAssets(documents)) {
    const hash = ref.slice('asset:'.length);
    if (![...files.keys()].some((key) => key.endsWith(`assets/${hash}`))) {
      problems.push(`asset ${hash} is referenced but not in the vault`);
    }
  }
  return problems;
}

function existsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
