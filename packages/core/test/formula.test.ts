import { describe, expect, it } from 'vitest';
import {
  evaluateFormula,
  FormulaError,
  formulaDependencies,
  parseFormula,
  type FormulaValue,
} from '../src/formula';

const props: Record<string, FormulaValue> = {
  Prix: 12.5,
  Quantité: 4,
  Nom: 'Widget',
  Actif: true,
  Vide: null,
  Tags: ['a', 'b'],
};
const ctx = { prop: (name: string) => props[name] ?? null };
const ev = (src: string) => evaluateFormula(src, ctx);

describe('parsing', () => {
  it('rejects bad syntax with a reportable error', () => {
    expect(() => parseFormula('1 +')).toThrow(FormulaError);
    expect(() => parseFormula('prop(Nom)')).toThrow(FormulaError);
    expect(() => parseFormula('"unterminated')).toThrow(FormulaError);
    expect(() => parseFormula('1 2')).toThrow(FormulaError);
  });

  it('lists dependencies for cycle detection', () => {
    const ast = parseFormula('prop("A") + if(prop("B") > 1, prop("C"), prop("A"))');
    expect(formulaDependencies(ast).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('arithmetic and precedence', () => {
  it('respects operator precedence and parentheses', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('-3 + 10')).toBe(7);
    expect(ev('10 % 3')).toBe(1);
  });

  it('computes from properties', () => {
    expect(ev('prop("Prix") * prop("Quantité")')).toBe(50);
    expect(ev('round(prop("Prix") * 1.2, 2)')).toBe(15);
  });

  it('division by zero and NaN degrade to null, never Infinity or NaN', () => {
    expect(ev('1 / 0')).toBeNull();
    expect(ev('prop("Nom") * 2')).toBeNull();
    expect(ev('sqrt(-1)')).toBeNull();
  });
});

describe('strings, booleans, comparison', () => {
  it('concatenates when either side is text', () => {
    expect(ev('prop("Nom") + " x" + prop("Quantité")')).toBe('Widget x4');
    expect(ev('concat(prop("Nom"), "!", 3)')).toBe('Widget!3');
  });

  it('compares numerically when possible, textually otherwise', () => {
    expect(ev('prop("Quantité") > 3')).toBe(true);
    expect(ev('"10" > "9"')).toBe(true); // both numeric-ish → numeric compare
    expect(ev('"abc" < "abd"')).toBe(true);
    expect(ev('prop("Prix") == 12.5')).toBe(true);
    expect(ev('prop("Nom") != "Autre"')).toBe(true);
  });

  it('short-circuits and/or', () => {
    expect(ev('false && (1 / 0)')).toBe(false);
    expect(ev('true || (1 / 0)')).toBe(true);
    expect(ev('not prop("Actif")')).toBe(false);
  });
});

describe('functions', () => {
  it('if, empty and length', () => {
    expect(ev('if(prop("Quantité") > 3, "beaucoup", "peu")')).toBe('beaucoup');
    expect(ev('empty(prop("Vide"))')).toBe(true);
    expect(ev('empty(prop("Nom"))')).toBe(false);
    expect(ev('length(prop("Nom"))')).toBe(6);
    expect(ev('length(prop("Tags"))')).toBe(2);
  });

  it('text helpers', () => {
    expect(ev('upper(prop("Nom"))')).toBe('WIDGET');
    expect(ev('replace(prop("Nom"), "Wid", "Gad")')).toBe('Gadget');
    expect(ev('slice(prop("Nom"), 0, 3)')).toBe('Wid');
    expect(ev('trim("  x  ")')).toBe('x');
  });

  it('aggregates flatten array arguments', () => {
    expect(ev('sum(1, 2, 3)')).toBe(6);
    expect(ev('max(prop("Prix"), prop("Quantité"))')).toBe(12.5);
    expect(ev('average(2, 4, 6)')).toBe(4);
    expect(ev('count(prop("Tags"))')).toBe(2);
    expect(ev('join("-", prop("Tags"))')).toBe('a-b');
  });

  it('contains works on text and lists', () => {
    expect(ev('contains(prop("Nom"), "idg")')).toBe(true);
    expect(ev('contains(prop("Tags"), "b")')).toBe(true);
    expect(ev('contains(prop("Tags"), "z")')).toBe(false);
  });

  it('unknown functions and bad args yield null instead of throwing', () => {
    expect(ev('nosuchfunction(1)')).toBeNull();
    expect(ev('round("abc")')).toBeNull();
    expect(evaluateFormula('1 +', ctx)).toBeNull(); // parse error → null
  });

  it('missing properties are null, not crashes', () => {
    expect(ev('prop("Inexistante")')).toBeNull();
    expect(ev('prop("Inexistante") + 1')).toBeNull();
    expect(ev('if(empty(prop("Inexistante")), "vide", "plein")')).toBe('vide');
  });
});
