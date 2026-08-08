import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The anti-patterns, as rules rather than intentions.
 *
 * @remarks
 * `docs/research/competitive-landscape.md` lists what users of the competition
 * consistently resent, and most of the list is about *restraint* — things not
 * done rather than things built. Restraint is exactly what erodes without a
 * test: nobody adds telemetry deliberately, they add "just a small ping", and
 * a licence boundary moves in a commit labelled "docs: update docs" (AFFiNE's,
 * verbatim).
 *
 * So the ones that are checkable are checked here.
 */

const ROOT = join(__dirname, '..');
const AREAS = ['packages', 'apps', 'examples', 'site'];

/** Every source file we ship, excluding build output and dependencies. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.build', 'target'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs|vue|svelte|astro)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(path);
      }
    }
  };
  for (const area of AREAS) walk(join(ROOT, area));
  return out;
}

const FILES = sources();

/** The text of every shipped source file, with its path. */
const CONTENTS = FILES.map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }));

describe('nothing phones home', () => {
  it('there is no telemetry, no analytics, no beacon', () => {
    /*
     * The survey's sharpest case: AFFiNE's telemetry could not be turned off
     * even with the documented environment variable, and users in the EU were
     * asking whether it was legal. One incident of this kind permanently
     * changes how a product is discussed.
     */
    const offenders = CONTENTS.filter(({ text }) =>
      /navigator\.sendBeacon|googletagmanager|google-analytics|plausible\.io|posthog|mixpanel|segment\.io|telemetry/i.test(
        text,
      ),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it('no source hard-codes a third-party endpoint', () => {
    // a CDN script or a remote font is the quiet version of the same thing:
    // it works in development and reaches out in production
    const allowed =
      /localhost|127\.0\.0\.1|example\.(fr|com|invalid)|exemple\.fr|w3\.org|schema\.org|lucide\.dev|github\.com|github\.io|loro\.dev|obsidian\.md|willowprotocol|atproto|matrix\.org|solidproject|tonsky|inkandswitch|ucan-wg|libp2p|veilid|iroh|automerge|yjs|news\.ycombinator|dustycloud|corbado|lilting\.ch|datatracker|appsonair|bloggeek|practicalpkm|affine\.pro|apps\.apple|anytype|sneekes|notion\.com|nbe\.local/i;
    const offenders: string[] = [];
    for (const { path, text } of CONTENTS) {
      for (const match of text.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
        const url = match[0];
        /*
         * A real endpoint has a dotted hostname and no interpolation. Excluded:
         * `new URL(…, 'http://relay')` parsing bases, which have no TLD; a
         * `https://${…}` template for text a user typed; and `https://…` as a
         * field placeholder. Flagging those would make the test noise, and a
         * noisy guard gets deleted rather than heeded.
         */
        if (url.includes('${') || url.includes('…')) continue;
        const host = url.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
        if (!host.includes('.')) continue;
        if (!allowed.test(url)) offenders.push(`${path}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no AI is bolted on', () => {
  it('no package depends on an LLM SDK', () => {
    /*
     * The survey calls unsolicited AI "the most reliable source of contempt in
     * the corpus", and AppFlowy's self-hosted stack will not boot without an
     * OpenAI key — their most-upvoted open issue. If AI ever ships here it is
     * user-supplied keys, off by default, and this test changes deliberately.
     */
    const manifests = ['packages', 'apps', 'examples']
      .flatMap((area) =>
        existsSync(join(ROOT, area))
          ? readdirSync(join(ROOT, area)).map((name) => join(ROOT, area, name, 'package.json'))
          : [],
      )
      .filter(existsSync);

    const banned = /openai|anthropic|@ai-sdk|langchain|llamaindex|ollama/i;
    const offenders: string[] = [];
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (banned.test(name)) offenders.push(`${path.slice(ROOT.length + 1)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the files stay the truth', () => {
  it('the vault export writes documents and assets, and nothing about the author', () => {
    /*
     * Notion's published pages leak contributor names, photos and email
     * addresses in page metadata — documented, but buried. An export that
     * carried a machine name or an account would be the same category of
     * mistake, and the frontmatter is where it would land.
     */
    const vault = readFileSync(join(ROOT, 'packages/workspace/src/vault.ts'), 'utf8');
    const frontmatter = /function frontmatter\([\s\S]*?\n}/.exec(vault)?.[0] ?? '';
    expect(frontmatter).toBeTruthy();
    for (const leak of ['user', 'author', 'email', 'machine', 'hostname', 'device']) {
      expect(frontmatter.toLowerCase(), `frontmatter should not carry ${leak}`).not.toContain(leak);
    }
  });
});

describe('D8: the drag is ours, the file drop is the browser’s', () => {
  const DOM = CONTENTS.filter(({ path }) => path.startsWith('packages/dom/src'));

  it('no block drag goes through HTML5 drag-and-drop', () => {
    /*
     * D8 chose an in-house pointer-events primitive because native HTML5 DnD
     * cannot start from touch, cannot style its preview, gives no data during
     * `dragover`, and auto-scrolls badly — the four limits that made Pragmatic
     * unsuitable too, since it builds on the same API.
     *
     * The reason to test rather than trust: `draggable` is the obvious thing a
     * contributor reaches for, and it would work on a desktop mouse and quietly
     * fail on every phone.
     */
    const offenders: string[] = [];
    for (const { path, text } of DOM) {
      // our own primitive is *called* `draggable`; the attribute is the banned one
      if (/\bdraggable\s*=\s*["']?true|setAttribute\(\s*['"]draggable/.test(text)) {
        offenders.push(`${path}: draggable attribute`);
      }
      if (/addEventListener\(\s*['"]dragstart/.test(text)) offenders.push(`${path}: dragstart`);
      if (/dataTransfer\.setData/.test(text)) offenders.push(`${path}: dataTransfer.setData`);
    }
    expect(offenders).toEqual([]);
  });

  it('the native drop listeners exist only where OS files arrive', () => {
    // the documented exception: a file dragged in from the desktop is the one
    // thing only the browser can tell us about
    const withNativeDrop = DOM.filter(({ text }) => /addEventListener\(\s*['"]drop['"]/.test(text)).map((f) => f.path);
    expect(withNativeDrop.sort()).toEqual(['packages/dom/src/clipboard.ts', 'packages/dom/src/ui/upload.ts']);
  });
});
