// The plugin contract. Each test here pins a decision taken against a
// documented failure in another editor, so the reasoning survives the diff.
import { describe, expect, it } from 'vitest';
import {
  at,
  byPrecedence,
  lossy,
  PluginRegistry,
  PluginVersionError,
  PRECEDENCE_ORDER,
  type BlockPlugin,
} from '../src/plugin';

const plugin = (type: string, apiVersion = 1): BlockPlugin =>
  ({ apiVersion, schema: { type, version: 1, inline: true } }) as BlockPlugin;

describe('precedence', () => {
  it('orders by named category, highest first', () => {
    const sorted = byPrecedence([at('low', 'l'), at('highest', 'h'), at('default', 'd')]);
    expect(sorted).toEqual(['h', 'd', 'l']);
  });

  it('treats an untagged contribution as default', () => {
    expect(byPrecedence([at('low', 'l'), 'plain', at('high', 'h')])).toEqual(['h', 'plain', 'l']);
  });

  it('keeps registration order within a category', () => {
    // the tiebreak is the array the host wrote, which is observable —
    // unlike a number nobody can see the effect of
    expect(byPrecedence([at('high', 'a'), at('high', 'b'), at('high', 'c')])).toEqual(['a', 'b', 'c']);
  });

  it('is stable across the whole ladder', () => {
    const items = PRECEDENCE_ORDER.map((p) => at(p, p));
    expect(byPrecedence([...items].reverse())).toEqual([...PRECEDENCE_ORDER]);
  });

  it('does not mistake a plain object for a ranked one', () => {
    const value = { precedence: 'urgent', value: 'x' };
    expect(byPrecedence([value])).toEqual([value]);
  });
});

describe('api version', () => {
  it('registers a plugin written against the current contract', () => {
    expect(() => new PluginRegistry().register(plugin('callout'))).not.toThrow();
  });

  it('refuses a plugin from a future contract, by name', () => {
    // v1 and v2 plugins can then coexist during a migration instead of every
    // author breaking on one flag day
    expect(() => new PluginRegistry().register(plugin('callout', 2))).toThrow(PluginVersionError);
    expect(() => new PluginRegistry().register(plugin('callout', 2))).toThrow(/callout.*v2.*v1/);
  });
});

describe('registry is per-instance', () => {
  it('does not share registrations between two registries', () => {
    // two editors on one page is the second demo anyone writes; module-global
    // registries make different block sets impossible
    const a = new PluginRegistry().register(plugin('callout'));
    const b = new PluginRegistry();
    expect(a.has('callout')).toBe(true);
    expect(b.has('callout')).toBe(false);
  });

  it('lets the later registration of a type win', () => {
    const r = new PluginRegistry();
    const first = plugin('callout');
    const second = plugin('callout');
    r.register(first).register(second);
    expect(r.get('callout')).toBe(second);
    expect(r.types()).toEqual(['callout']);
  });

  it('registers a set in one call and reports them all', () => {
    const r = new PluginRegistry().registerAll([plugin('a'), plugin('b')]);
    expect(r.types().sort()).toEqual(['a', 'b']);
    expect(r.all()).toHaveLength(2);
  });
});

describe('lossy projections are declared, not omitted', () => {
  it('still serializes, and says what it dropped', () => {
    const projection = lossy('columns flatten to their contents', (b) => [`<!-- ${b.type} -->`]);
    expect(projection.lossyReason).toBe('columns flatten to their contents');
    expect(projection.toMarkdown({ type: 'column_list' } as never, { child: () => [], depth: 0 })).toEqual([
      '<!-- column_list -->',
    ]);
  });

  it('parses nothing back, which is what makes the loss visible', () => {
    expect(lossy('x', () => []).fromMarkdown).toEqual([]);
  });
});
