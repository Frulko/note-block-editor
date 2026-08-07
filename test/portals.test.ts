import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Floating chrome must carry the token scope with it.
 *
 * @remarks
 * The design tokens are declared on the editor element, so anything appended
 * to `document.body` inherits none of them. That was a hand-maintained list of
 * eight component class names in `tokens.css`, and it drifted: on 2026-08-07
 * the drop guide and the drag ghost both resolved `--nbe-accent-rgb` to
 * nothing and painted `rgba(0, 0, 0, 0)` — an invisible drop indicator, which
 * is most of why dragging read as broken.
 *
 * `ui/portal.ts` replaced the list with one marker class. This is the tripwire
 * that keeps it from growing back: a raw `document.body.append` in the view
 * layer is a component that will paint untokenised.
 */

const SRC = join(import.meta.dirname, '..', 'packages', 'dom', 'src');

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

/** Strip comments, so an example in a doc block is not mistaken for code. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('chrome mounted outside the editor keeps its tokens', () => {
  it('nothing appends to document.body except the portal helper', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith(join('ui', 'portal.ts'))) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      // `upload.ts` mounts a bare <input type=file>, which is never painted
      if (/document\.body\.append(?!\(input\))/.test(code)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the token scope is one marker class, not a list of component names', () => {
    const tokens = readFileSync(join(SRC, 'style', 'tokens.css'), 'utf8');
    expect(tokens).toContain('.nbe-portal');
    // the old list is what drifted; these must not come back as token roots
    for (const drifted of ['.nbe-seltoolbar,', '.nbe-iconpicker,', '.nbe-tooltip,']) {
      expect(tokens).not.toContain(drifted);
    }
  });

  it('the marker is applied where the element is mounted', () => {
    const portal = readFileSync(join(SRC, 'ui', 'portal.ts'), 'utf8');
    expect(portal).toContain("classList.add(PORTAL_CLASS)");
    expect(portal).toContain('document.body.append(el)');
  });
});
