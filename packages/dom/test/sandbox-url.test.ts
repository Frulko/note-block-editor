// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSandboxUrls, sandboxUrl } from '../src/render';

/**
 * The URL a sandboxed embed can actually load.
 *
 * @remarks
 * The frame asks for `allow-scripts` without `allow-same-origin`, which is
 * what makes a dropped page harmless — and it gives the frame an opaque
 * origin, which cannot navigate to a host's private scheme. In the browser
 * this never surfaced, because the asset store already hands back a `blob:`;
 * inside Obsidian `resolveAssetUrl` returns an `app://` resource path and the
 * frame stayed blank with nothing in the console.
 */

let fetched: string[] = [];

beforeEach(() => {
  __resetSandboxUrls();
  fetched = [];
  let n = 0;
  vi.stubGlobal('fetch', (url: string) => {
    fetched.push(url);
    return Promise.resolve({ blob: () => Promise.resolve(new Blob(['<p>ok</p>'], { type: 'text/html' })) });
  });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:fake-${++n}` }));
});

afterEach(() => vi.unstubAllGlobals());

describe('sandboxUrl', () => {
  it('leaves alone what an opaque origin can already read', async () => {
    expect(await sandboxUrl('blob:abc')).toBe('blob:abc');
    expect(await sandboxUrl('data:text/html,x')).toBe('data:text/html,x');
    expect(fetched).toEqual([]);
  });

  it('re-serves a host scheme as a blob', async () => {
    expect(await sandboxUrl('app://vault/note/proto.html')).toBe('blob:fake-1');
    expect(fetched).toEqual(['app://vault/note/proto.html']);
  });

  it('fetches a given src once, so a re-render does not reload the frame', async () => {
    const first = await sandboxUrl('app://vault/proto.html');
    const second = await sandboxUrl('app://vault/proto.html');
    expect(second).toBe(first);
    expect(fetched).toHaveLength(1);
  });

  it('falls back to the raw URL when the scheme refuses fetch too', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('nope')));
    // not nothing at all, which is what the frame got before
    expect(await sandboxUrl('weird://thing.html')).toBe('weird://thing.html');
  });
});
