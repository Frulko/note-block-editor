import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTOFORMAT_RULES } from '../packages/core/src/commands';
import { codePlugin } from '../packages/blocks-code/src/index';

/*
 * The Swift port has no plugin system: it is a client, and it ships the block
 * set the apps ship. So its table is core's *plus* the rules the block plugins
 * contribute — which is what this composes, rather than letting ``` drift out
 * of the comparison the day the code block left core.
 */
const RULES = [...AUTOFORMAT_RULES, ...(codePlugin.autoformat ?? [])];

/**
 * The two implementations, held to the same tables.
 *
 * @remarks
 * A second implementation finds the first one's blind spots — and produces its
 * own bug class in exchange: **both sides work, neither is wrong, and the same
 * keystroke does two different things.** Nothing catches that at runtime,
 * because neither peer is misbehaving.
 *
 * So the tables that define *meaning* rather than mechanism are compared here.
 * Reading the Swift source as text is crude and it is the point: no build step,
 * no fixture to regenerate and forget, and it fails on the same commit that
 * introduces the drift.
 */

const root = join(import.meta.dirname, '..');
const swift = (path: string): string => readFileSync(join(root, 'native', 'swift', path), 'utf8');

describe('markdown autoformat is the same table in both languages', () => {
  const source = swift('Sources/NbeModel/Autoformat.swift');

  /** `Rule(prefix: "# ", type: "heading", props: ["level": .number(1)])` */
  const parsed = [...source.matchAll(/Rule\(prefix: "((?:[^"\\]|\\.)*)", type: "([^"]+)"(?:, props: \[([^\]]*)\])?\)/g)].map(
    (match) => ({
      prefix: match[1]!.replace(/\\"/g, '"'),
      type: match[2]!,
      props: match[3] ?? '',
    }),
  );

  it('finds every rule in the Swift source (the regex has not rotted)', () => {
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
        // `level: 1` reads as `"level": .number(1)`, `checked: true` as `.bool(true)`
        expect(mirror.props, `${rule.prefix} → ${key}`).toContain(`"${key}"`);
        expect(mirror.props, `${rule.prefix} → ${key}=${String(value)}`).toContain(`(${String(value)})`);
      }
      if (!rule.props) expect(mirror.props).toBe('');
    }
  });
});

describe('Enter continues the same block types in both languages', () => {
  it('the continuing set matches', () => {
    // the TypeScript side keeps this private on purpose, so it is read the same
    // way as the Swift side — the table is the contract, not the export
    const ts = readFileSync(join(root, 'packages', 'core', 'src', 'commands.ts'), 'utf8');
    const list = (source: string, marker: RegExp): string[] => {
      const match = source.match(marker);
      if (!match) throw new Error(`liste introuvable : ${marker}`);
      return [...match[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)].map((hit) => hit[1] ?? hit[2]!).sort();
    };

    expect(list(swift('Sources/NbeSync/DocumentWriter.swift'), /continuingTypes: Set<String> = \[([^\]]+)\]/)).toEqual(
      list(ts, /CONTINUING_TYPES = new Set\(\[([^\]]+)\]/),
    );
  });
});
