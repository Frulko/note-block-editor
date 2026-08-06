/**
 * Formula language (AQ#8): a small, total, pure expression evaluator.
 *
 * Design rules, all deliberate:
 * - no I/O, no clock, no randomness — a formula is a pure function of the row,
 *   so results are reproducible, cacheable, and safe to recompute anywhere
 *   (browser, CLI, future native client)
 * - never throws at evaluation time: bad input yields `null`, so one broken
 *   formula can never take a table down. Parse errors ARE reported, because
 *   they are authoring feedback.
 * - properties are referenced by name via prop("Name"), which keeps formulas
 *   readable and lets the schema rename them without touching ids
 */

export type FormulaValue = number | string | boolean | null | FormulaValue[];

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'prop'; name: string }
  | { k: 'unary'; op: '-' | 'not'; a: Expr }
  | { k: 'binary'; op: string; a: Expr; b: Expr }
  | { k: 'call'; name: string; args: Expr[] };

export class FormulaError extends Error {}

// ------------------------------------------------------------------ tokens

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

const OPERATORS = [
  '>=', '<=', '==', '!=', '&&', '||',
  '+', '-', '*', '/', '%', '>', '<', '=', '(', ')', ',',
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      const num = Number(src.slice(i, j));
      if (Number.isNaN(num)) throw new FormulaError(`Nombre invalide: ${src.slice(i, j)}`);
      out.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          value += src[j + 1];
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new FormulaError('Chaîne non terminée');
      out.push({ t: 'str', v: value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-zÀ-ÿ_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-zÀ-ÿ0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Caractère inattendu: ${c}`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'eof' });
  return out;
}

// ------------------------------------------------------------------ parser

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '=': 3,
  '!=': 3,
  '>': 4,
  '<': 4,
  '>=': 4,
  '<=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** Parse a formula source into an AST. Throws FormulaError on bad syntax. */
export function parseFormula(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const eat = (): Token => tokens[pos++]!;
  const expectOp = (op: string) => {
    const tok = eat();
    if (tok.t !== 'op' || tok.v !== op) throw new FormulaError(`"${op}" attendu`);
  };

  const parseExpr = (minPrec = 0): Expr => {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (tok.t !== 'op') break;
      const prec = BINARY_PRECEDENCE[tok.v];
      if (prec === undefined || prec < minPrec) break;
      eat();
      const right = parseExpr(prec + 1);
      left = { k: 'binary', op: tok.v === '=' ? '==' : tok.v, a: left, b: right };
    }
    return left;
  };

  const parseUnary = (): Expr => {
    const tok = peek();
    if (tok.t === 'op' && tok.v === '-') {
      eat();
      return { k: 'unary', op: '-', a: parseUnary() };
    }
    if (tok.t === 'ident' && tok.v.toLowerCase() === 'not') {
      eat();
      return { k: 'unary', op: 'not', a: parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): Expr => {
    const tok = eat();
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'str') return { k: 'str', v: tok.v };
    if (tok.t === 'op' && tok.v === '(') {
      const inner = parseExpr();
      expectOp(')');
      return inner;
    }
    if (tok.t === 'ident') {
      const lower = tok.v.toLowerCase();
      if (lower === 'true') return { k: 'bool', v: true };
      if (lower === 'false') return { k: 'bool', v: false };
      if (lower === 'null') return { k: 'null' };
      if (peek().t === 'op' && (peek() as { v: string }).v === '(') {
        eat();
        const args: Expr[] = [];
        if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
          for (;;) {
            args.push(parseExpr());
            const next = peek();
            if (next.t === 'op' && next.v === ',') {
              eat();
              continue;
            }
            break;
          }
        }
        expectOp(')');
        if (lower === 'prop') {
          const arg = args[0];
          if (args.length !== 1 || !arg || arg.k !== 'str') {
            throw new FormulaError('prop() attend un nom de propriété entre guillemets');
          }
          return { k: 'prop', name: arg.v };
        }
        return { k: 'call', name: lower, args };
      }
      throw new FormulaError(`Identifiant inconnu: ${tok.v} (utilise prop("Nom"))`);
    }
    throw new FormulaError('Expression attendue');
  };

  const ast = parseExpr();
  if (peek().t !== 'eof') throw new FormulaError('Fin d’expression attendue');
  return ast;
}

// --------------------------------------------------------------- coercions

export function toNumber(v: FormulaValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

export function toStringValue(v: FormulaValue): string {
  if (v === null) return '';
  if (Array.isArray(v)) return v.map(toStringValue).join(', ');
  return String(v);
}

export function toBoolean(v: FormulaValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return v === true;
}

function isEmpty(v: FormulaValue): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** null-safe number result: NaN and Infinity become null rather than junk. */
function num(n: number): FormulaValue {
  return Number.isFinite(n) ? n : null;
}

// -------------------------------------------------------------- evaluation

type Fn = (args: FormulaValue[]) => FormulaValue;

const FUNCTIONS: Record<string, Fn> = {
  if: ([cond, a, b]) => (toBoolean(cond ?? null) ? (a ?? null) : (b ?? null)),
  and: (args) => args.every((a) => toBoolean(a)),
  or: (args) => args.some((a) => toBoolean(a)),
  not: ([a]) => !toBoolean(a ?? null),
  empty: ([a]) => isEmpty(a ?? null),
  concat: (args) => args.map(toStringValue).join(''),
  join: (args) => {
    const [sep, ...rest] = args;
    return rest.flatMap((v) => (Array.isArray(v) ? v : [v])).map(toStringValue).join(toStringValue(sep ?? null));
  },
  length: ([a]) => (Array.isArray(a) ? a.length : toStringValue(a ?? null).length),
  contains: ([a, b]) =>
    Array.isArray(a)
      ? a.map(toStringValue).includes(toStringValue(b ?? null))
      : toStringValue(a ?? null).includes(toStringValue(b ?? null)),
  upper: ([a]) => toStringValue(a ?? null).toUpperCase(),
  lower: ([a]) => toStringValue(a ?? null).toLowerCase(),
  trim: ([a]) => toStringValue(a ?? null).trim(),
  replace: ([a, from, to]) =>
    toStringValue(a ?? null).split(toStringValue(from ?? null)).join(toStringValue(to ?? null)),
  slice: ([a, from, to]) =>
    toStringValue(a ?? null).slice(toNumber(from ?? 0), to === undefined ? undefined : toNumber(to)),
  round: ([a, digits]) => {
    const f = 10 ** (digits === undefined ? 0 : Math.trunc(toNumber(digits)));
    return num(Math.round(toNumber(a ?? null) * f) / f);
  },
  floor: ([a]) => num(Math.floor(toNumber(a ?? null))),
  ceil: ([a]) => num(Math.ceil(toNumber(a ?? null))),
  abs: ([a]) => num(Math.abs(toNumber(a ?? null))),
  sqrt: ([a]) => num(Math.sqrt(toNumber(a ?? null))),
  min: (args) => num(Math.min(...flatten(args).map(toNumber))),
  max: (args) => num(Math.max(...flatten(args).map(toNumber))),
  sum: (args) => num(flatten(args).map(toNumber).filter(Number.isFinite).reduce((a, b) => a + b, 0)),
  average: (args) => {
    const nums = flatten(args).map(toNumber).filter(Number.isFinite);
    return nums.length ? num(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  },
  count: (args) => flatten(args).filter((v) => !isEmpty(v)).length,
  number: ([a]) => num(toNumber(a ?? null)),
  text: ([a]) => toStringValue(a ?? null),
};

function flatten(args: FormulaValue[]): FormulaValue[] {
  return args.flatMap((a) => (Array.isArray(a) ? a : [a]));
}

export interface EvalContext {
  /** Resolve prop("Name") to a value; unknown names yield null. */
  prop: (name: string) => FormulaValue;
}

/** Evaluate an AST. Never throws — invalid operations produce null. */
export function evaluateExpr(expr: Expr, ctx: EvalContext): FormulaValue {
  switch (expr.k) {
    case 'num':
      return expr.v;
    case 'str':
      return expr.v;
    case 'bool':
      return expr.v;
    case 'null':
      return null;
    case 'prop':
      return ctx.prop(expr.name);
    case 'unary': {
      const a = evaluateExpr(expr.a, ctx);
      return expr.op === '-' ? num(-toNumber(a)) : !toBoolean(a);
    }
    case 'binary': {
      const a = evaluateExpr(expr.a, ctx);
      // short-circuit before evaluating the right side
      if (expr.op === '&&') return toBoolean(a) ? toBoolean(evaluateExpr(expr.b, ctx)) : false;
      if (expr.op === '||') return toBoolean(a) ? true : toBoolean(evaluateExpr(expr.b, ctx));
      const b = evaluateExpr(expr.b, ctx);
      switch (expr.op) {
        case '+':
          // string concatenation when either side is textual (spreadsheet feel)
          if (typeof a === 'string' || typeof b === 'string') return toStringValue(a) + toStringValue(b);
          return num(toNumber(a) + toNumber(b));
        case '-':
          return num(toNumber(a) - toNumber(b));
        case '*':
          return num(toNumber(a) * toNumber(b));
        case '/':
          return num(toNumber(a) / toNumber(b));
        case '%':
          return num(toNumber(a) % toNumber(b));
        case '==':
          return equals(a, b);
        case '!=':
          return !equals(a, b);
        case '>':
        case '<':
        case '>=':
        case '<=': {
          const na = toNumber(a);
          const nb = toNumber(b);
          const [x, y] = Number.isFinite(na) && Number.isFinite(nb) ? [na, nb] : [toStringValue(a), toStringValue(b)];
          if (expr.op === '>') return x > y;
          if (expr.op === '<') return x < y;
          if (expr.op === '>=') return x >= y;
          return x <= y;
        }
        default:
          return null;
      }
    }
    case 'call': {
      const fn = FUNCTIONS[expr.name];
      if (!fn) return null;
      try {
        return fn(expr.args.map((a) => evaluateExpr(a, ctx)));
      } catch {
        return null; // a formula must never take the table down
      }
    }
  }
}

function equals(a: FormulaValue, b: FormulaValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return toStringValue(a) === toStringValue(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return toStringValue(a) === toStringValue(b);
}

/** Parse + evaluate in one call. Parse errors yield null (use parseFormula to surface them). */
export function evaluateFormula(source: string, ctx: EvalContext): FormulaValue {
  try {
    return evaluateExpr(parseFormula(source), ctx);
  } catch {
    return null;
  }
}

/** Property names a formula reads — the dependency edges for cycle detection. */
export function formulaDependencies(expr: Expr): string[] {
  const out: string[] = [];
  const walk = (e: Expr) => {
    switch (e.k) {
      case 'prop':
        out.push(e.name);
        break;
      case 'unary':
        walk(e.a);
        break;
      case 'binary':
        walk(e.a);
        walk(e.b);
        break;
      case 'call':
        e.args.forEach(walk);
        break;
    }
  };
  walk(expr);
  return [...new Set(out)];
}

export const FORMULA_FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
