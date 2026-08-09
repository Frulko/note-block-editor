import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A pasted file becomes a file in the folder.
 *
 * @remarks
 * The desktop store is the one place where "the folder is the storage" (§10)
 * has to hold for bytes rather than for text, and it is the half a type-check
 * cannot see: the path is derived from a hash, and the MIME on the way back is
 * derived from the extension the way in chose. Get either wrong and the folder
 * still looks right while a PDF refuses to preview.
 *
 * The filesystem is a mock because the real one is Tauri's, which exists only
 * inside its webview — the same reason `storage.ts` has a `NATIVE` fallback.
 */
const files = new Map<string, Uint8Array>();

// by path, not by name: the package is a dependency of the desktop app and
// does not resolve from here, and a mock keyed on a name nothing resolves is a
// mock that silently does not apply
vi.mock('../apps/desktop/node_modules/@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`)),
  mkdir: async () => undefined,
  readFile: async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  },
  readDir: async () => [],
  readTextFile: async () => '',
  remove: async () => undefined,
  rename: async () => undefined,
  writeFile: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
  writeTextFile: async () => undefined,
}));

const { vaultAssets } = await import('../apps/desktop/src/storage');

beforeEach(() => files.clear());

describe('the desktop asset store', () => {
  it('writes the file into the vault and hands back the path', async () => {
    const assets = vaultAssets('/vault');
    const src = await assets.store(new File([new Uint8Array([1, 2, 3])], 'photo.PNG', { type: 'image/png' }));

    expect(src).toMatch(/^assets\/[0-9a-f]{32}\.png$/);
    expect(files.has(`/vault/${src}`)).toBe(true);
  });

  it('is content-addressed, so the same picture twice is one file', async () => {
    const assets = vaultAssets('/vault');
    const bytes = new Uint8Array([9, 9, 9]);
    const first = await assets.store(new File([bytes], 'a.png', { type: 'image/png' }));
    const second = await assets.store(new File([bytes], 'b.png', { type: 'image/png' }));

    expect(second).toBe(first);
    expect(files.size).toBe(1);
  });

  it('names a file the MIME describes when its own name says nothing', async () => {
    const assets = vaultAssets('/vault');
    const src = await assets.store(new Blob([new Uint8Array([1])], { type: 'application/pdf' }));
    expect(src.endsWith('.pdf')).toBe(true);
  });

  it('resolves a vault path to a blob URL carrying the right type', async () => {
    const assets = vaultAssets('/vault');
    const src = await assets.store(new File([new Uint8Array([1])], 'notice.pdf', { type: 'application/pdf' }));

    const url = await assets.resolve(src);
    expect(url.startsWith('blob:')).toBe(true);
    // the type is the point: an <object> viewer is chosen by Content-Type, and
    // bytes read back off the disk carry none
    const { resolveObjectURL } = await import('node:buffer');
    expect(resolveObjectURL(url)?.type).toBe('application/pdf');
    // one URL per file, not one per render
    expect(await assets.resolve(src)).toBe(url);
  });

  it('leaves a src the browser can already load alone', async () => {
    const assets = vaultAssets('/vault');
    for (const src of ['https://exemple.fr/a.png', 'data:image/png;base64,AA', 'blob:x']) {
      expect(await assets.resolve(src)).toBe(src);
    }
  });
});
