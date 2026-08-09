import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTOFORMAT_RULES } from '../packages/core/src/commands';
import { codePlugin } from '../packages/blocks-code/src/index';

/*
 * Le port Rust (GPUI) est un client, comme le port Swift : pas de système de
 * plugins, il embarque le jeu de blocs que les apps embarquent. Sa table est
 * donc celle de core *plus* les règles des plugins de blocs.
 */
const RULES = [...AUTOFORMAT_RULES, ...(codePlugin.autoformat ?? [])];

/**
 * La troisième implémentation, tenue aux mêmes tables que les deux autres.
 *
 * @remarks
 * Même contrat que `swift-parity.test.ts` : les tables qui définissent le
 * *sens* d'une frappe — et pas le mécanisme — sont comparées en lisant la
 * source Rust comme du texte. Pas de build, pas de fixture à régénérer, et ça
 * casse au commit qui fait dériver.
 */

const root = join(import.meta.dirname, '..');
const rust = (path: string): string => readFileSync(join(root, 'native', 'gpui', path), 'utf8');

describe('markdown autoformat is the same table in TypeScript, Swift and Rust', () => {
  const source = rust('model/src/model.rs');

  /** `Rule { prefix: "# ", kind: "heading", props: &[("level", Prop::Num(1))] },` */
  const parsed = [...source.matchAll(/Rule \{ prefix: "((?:[^"\\]|\\.)*)", kind: "([^"]+)", props: &\[([^\]]*)\] \}/g)].map(
    (match) => ({
      prefix: match[1]!.replace(/\\"/g, '"'),
      type: match[2]!,
      props: match[3] ?? '',
    }),
  );

  it('finds every rule in the Rust source (the regex has not rotted)', () => {
    expect(parsed.length).toBe(RULES.length);
    expect(parsed.length).toBeGreaterThan(8);
  });

  it('the prefixes match, in order', () => {
    expect(parsed.map((rule) => rule.prefix)).toEqual(RULES.map((rule) => rule.prefix));
  });

  it('each prefix produces the same block type', () => {
    expect(parsed.map((rule) => rule.type)).toEqual(RULES.map((rule) => rule.type));
  });

  it('the props agree where there are any', () => {
    for (const [index, rule] of RULES.entries()) {
      const mirror = parsed[index]!;
      for (const [key, value] of Object.entries(rule.props ?? {})) {
        // `level: 1` reads as `("level", Prop::Num(1))`, `checked: true` as `Prop::Bool(true)`
        expect(mirror.props, `${rule.prefix} → ${key}`).toContain(`"${key}"`);
        expect(mirror.props, `${rule.prefix} → ${key}=${String(value)}`).toContain(`(${String(value)})`);
      }
      if (!rule.props) expect(mirror.props).toBe('');
    }
  });
});

describe('Enter continues the same block types in Rust', () => {
  it('the continuing set matches', () => {
    const ts = readFileSync(join(root, 'packages', 'core', 'src', 'commands.ts'), 'utf8');
    const list = (source: string, marker: RegExp): string[] => {
      const match = source.match(marker);
      if (!match) throw new Error(`liste introuvable : ${marker}`);
      return [...match[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)].map((hit) => hit[1] ?? hit[2]!).sort();
    };

    expect(list(rust('model/src/model.rs'), /CONTINUING_TYPES[^=]*= \[([^\]]+)\]/)).toEqual(
      list(ts, /CONTINUING_TYPES = new Set\(\[([^\]]+)\]/),
    );
  });
});
