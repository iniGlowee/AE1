/**
 * AE1 - the Angel Script s-expression reader.
 *
 * ONE reader serves both `dat` and `def`. That is the whole reason the
 * declarative sections are LISP rather than JSON or an ad-hoc grammar: `dat`
 * declares what an element IS, `def` declares how it BEHAVES, both are
 * declarative, and in LISP declarations are just data. Adding a new form later --
 * (mixin ...), (export ...) -- costs nothing at the parser level, because every
 * form is already a list.
 *
 * The reader is greedy and stops at the first token that is not `(`. That is how
 * the def section needs no delimiter between its declarations and its JavaScript:
 * the format parses itself.
 */

/** A bare identifier. Distinct from a string: (extends Openable) vs (name "Door"). */
export class Sym {
  constructor(name) {
    this.name = name;
  }
  toString() {
    return this.name;
  }
}

export const isSym = (v) => v instanceof Sym;

const WS = new Set([' ', '\t', '\n', '\r', '\f']);
const DELIM = new Set(['(', ')', ';', '"']);

export class ReadError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'ReadError';
    this.line = line;
    this.col = col;
  }
}

/**
 * Read s-expressions from `src` until a non-form token is reached.
 *
 * @param {string} src
 * @param {number} [start] byte offset to begin at
 * @returns {{ forms: any[], rest: string, restLine: number }}
 *   `rest` is everything after the last form -- the JavaScript, in a def block.
 */
export function read(src, start = 0) {
  let i = start;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  /** Skip whitespace and `;` comments. Returns true if anything was skipped. */
  function skipTrivia() {
    let moved = false;
    for (;;) {
      if (i >= src.length) return moved;

      if (WS.has(src[i])) {
        advance();
        moved = true;
        continue;
      }

      if (src[i] === ';') {
        while (i < src.length && src[i] !== '\n') advance();
        moved = true;
        continue;
      }

      return moved;
    }
  }

  function readString() {
    const startLine = line;
    const startCol = col;
    advance(); // opening quote

    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        advance();
        const c = src[i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
        advance();
        continue;
      }
      out += src[i];
      advance();
    }

    if (i >= src.length) throw new ReadError('Unterminated string.', startLine, startCol);
    advance(); // closing quote
    return out;
  }

  /** A bare token: number, boolean, nil, or symbol. */
  function readAtom() {
    let out = '';
    while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) {
      out += src[i];
      advance();
    }

    if (out === 'true') return true;
    if (out === 'false') return false;
    if (out === 'nil' || out === 'null') return null;

    // Only treat as a number if the whole token is one. "3d-model" is a symbol,
    // and parseFloat would silently turn it into 3.
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(out)) return Number(out);

    return new Sym(out);
  }

  function readForm() {
    const startLine = line;
    const startCol = col;
    advance(); // '('

    const items = [];
    for (;;) {
      skipTrivia();

      if (i >= src.length) {
        throw new ReadError('Unclosed "(" — missing ")".', startLine, startCol);
      }

      if (src[i] === ')') {
        advance();
        return items;
      }

      items.push(readValue());
    }
  }

  function readValue() {
    if (src[i] === '(') return readForm();
    if (src[i] === '"') return readString();
    if (src[i] === ')') throw new ReadError('Unexpected ")".', line, col);
    return readAtom();
  }

  /* -- drive -------------------------------------------------------------- */

  const forms = [];
  for (;;) {
    skipTrivia();
    if (i >= src.length) break;

    // The moment we see something that is not a form, the s-expression section
    // is over and the rest is JavaScript. No delimiter needed.
    if (src[i] !== '(') break;

    forms.push(readForm());
  }

  return { forms, rest: src.slice(i), restLine: line };
}

/**
 * Interpret a form as a `(key value...)` declaration.
 *
 * One value  -> the value          (health 100)      -> 100
 * Many       -> an array           (runInfo use (a b))
 * Empty      -> an empty array     (inventory ())    -> []
 */
export function formKey(form) {
  const head = form[0];
  if (!isSym(head)) return null;
  return head.name;
}

export function formValue(form) {
  const rest = form.slice(1);
  if (rest.length === 0) return [];
  if (rest.length === 1) return unwrap(rest[0]);
  return rest.map(unwrap);
}

/** Symbols collapse to their name; nested lists recurse. */
export function unwrap(v) {
  if (isSym(v)) return v.name;
  if (Array.isArray(v)) return v.map(unwrap);
  return v;
}
