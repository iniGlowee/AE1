/**
 * AE1 - the Angel Script compiler.
 *
 * AGS is NOT an interpreted language. It is a preprocessor that compiles to a JS
 * class on the element's prototype chain:
 *
 *   dat     -> instance properties (real accessors, so writes are observable)
 *   def     -> inheritance + runInfo scheduling metadata
 *   methods -> class methods
 *
 * The cost is that AGS may never diverge far from JS syntax. The benefit is ~300
 * lines instead of an interpreter, `super.use()` working natively, free devtools
 * debugging, and correctness that will still hold in ten years.
 *
 * The compiler ships IN THE RUNTIME and .ags.txt ships loose in exports, so the
 * editor and the exported game run the same code path (DESIGN.md, Principle 2)
 * and a modder edits the same surface an author authored on (Principle 3).
 */

import { read, formKey, formValue, ReadError } from './reader.js';

/** Where a method is called from. See DESIGN.md §6.3. */
export const RUN_INFO = {
  onLoad: 'lifecycle',
  onUnload: 'lifecycle',
  onTick: 'lifecycle',
  onCall: 'call',
  onClick: 'input',
  onHover: 'input',
  onExit: 'input',
  onDrag: 'input',
  // Media reached its end. Dispatched by AE1Video; never fires while looping.
  onEnded: 'media',
  // A clip finished. Dispatched by AE1Sprite when `(loop false)` runs out.
  onFinished: 'media',

  // Conversation, dispatched by AE1DialogueDelegate (engine/dialogue.js).
  //
  // These are modes, not methods: an author names the method and says WHEN it
  // runs, exactly as with onClick. A per-node action is `(does …)` in the tree
  // instead -- it belongs to that node, not to the whole conversation.
  onDialogueStart: 'dialogue',
  onNode: 'dialogue',
  onChoice: 'dialogue',
  onDialogueEnd: 'dialogue',

  // Third-person play, dispatched by AE1ThirdPersonCharacter
  // (engine/thirdperson.js) from the Controller's mapped buttons/physics.
  onPrimary: 'action',
  onSecondary: 'action',
  onJump: 'action',
  onLand: 'action',
  onInteract: 'action',

  // Item lifecycle, dispatched TO THE ITEM element by the character's
  // inventory (engine/thirdperson.js §18.11). The actor is the argument.
  onPickup: 'item',
  onDrop: 'item',
  onEquip: 'item',
  onUnequip: 'item',
  // ...and the TRAVERSAL stow (the motion-matching driver (not in the public build)): the wielded weapon
  // hides its meshes for a vault/climb (the reference game's weapons-vanish behavior) and
  // restores them on landing. Sheathed, the item is still EQUIPPED — the
  // inventory never changes, only the visuals step aside for the move.
  onSheathe: 'item',
  onUnsheathe: 'item',

  // A weapon connected (engine/npc.js takeDamage §18.12): (attacker, amount).
  onHit: 'combat',

  // An enemy STARTED an attack at you (engine/enemy.js §18.44): (evt) with
  // attacker/clip/kind/damage/x/y/z/t/state/target — the telegraph moment,
  // for dodge logic, effects, or reading the room. The global feed twin is
  // world.attackEvents (last 32, pollable every tick).
  onEnemyAttack: 'combat',

  // Camera cinematics (engine/cameracurve.js §18.49): a curve/course fires
  // onStart when it claims the camera (course: first curve), onEnd when it
  // releases (finish, stop(), or course exhausted).
  onStart: 'camera',
  onEnd: 'camera',

  // A pilotable Aircraft (engine/aircraft.js §18.52): boarding completes,
  // dismount completes, or the travel/flight mode flips ((mode) argument).
  onBoard: 'aircraft',
  onUnboard: 'aircraft',
  onModeChange: 'aircraft',

  // A FollowerPod (engine/followerpod.js §18.55): each bolt leaves the
  // muzzle, the charged shot fires, a bolt connects ((victim, damage)).
  onFire: 'followerpod',
  onSpecial: 'followerpod',
  onPodHit: 'followerpod',

  // The DebugMenu (engine/debugmenu.js §18.56): the wall opened (the frame
  // froze) and closed (flags applied, the loop resumed).
  onDebugOpen: 'debugmenu',
  onDebugClose: 'debugmenu',

  // A passive line just started (engine/passivedialogue.js §18.18): (line).
  onSpeak: 'dialogue',

  void: 'reserved',
};

/** Methods without a runInfo are plain helpers, invoked only by other scripts. */
export const DEFAULT_RUN_INFO = 'onCall';

const DAT_RE = /<\?dat\b([\s\S]*?)\?>/;
const DEF_RE = /<\?def\b([\s\S]*?)\bags\?>/;

/** A def form left behind in the JavaScript section. See the check in compileAGS. */
const STRANDED_RE = /^[ \t]*\((extends|name|runInfo)\s/m;

/**
 * A LISP comment left behind in the JavaScript section.
 *
 * `; like this` is a comment in dat/def and an empty statement followed by
 * garbage in JavaScript, so it fails as "Unexpected token 'while'" or similar --
 * naming a word from the middle of the author's own sentence, which is a
 * genuinely baffling thing to be told.
 *
 * I made this mistake three times while writing templates, knowing the rule.
 * A format with two comment syntaxes has earned a diagnostic.
 *
 * Requires a LETTER after the semicolon, so the defensive-semicolon idiom
 * `;(function(){})()` and a bare `;` are both left alone.
 */
const LISP_COMMENT_IN_JS_RE = /^[ \t]*;[ \t]*[A-Za-z]/m;

/**
 * Built-in element properties, which dat cannot shadow.
 *
 * Duplicated from element.js rather than imported: the compiler must stay
 * importable on its own (a lint, a build step, a test), and it needs the NAMES,
 * not the schema. If a property is added there and not here, the cost is a
 * missing warning -- not a wrong compile.
 */
const BASE_PROPERTIES = new Set([
  'name', 'type', 'tags',
  'x', 'y', 'layer', 'rotation', 'scaleX', 'scaleY',
  'width', 'height',
  'visible', 'opacity', 'flipH', 'flipV',
  'id', 'parent', 'extends', 'script', 'components',
]);

const countLines = (s) => (s.match(/\n/g) ?? []).length;

/* -------------------------------------------------------------------------- */
/* JavaScript scanning                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Skip a string or template literal, returning the index just past it.
 * Template `${...}` holes are skipped by brace matching, so a `}` inside one
 * cannot be mistaken for the end of an enclosing block.
 */
function skipString(js, i) {
  const q = js[i];
  i++;
  while (i < js.length) {
    if (js[i] === '\\') {
      i += 2;
      continue;
    }
    if (js[i] === q) return i + 1;
    if (q === '`' && js[i] === '$' && js[i + 1] === '{') {
      const end = matchBrace(js, i + 1);
      i = end < 0 ? js.length : end;
      continue;
    }
    i++;
  }
  return i;
}

/** From the `{` at `open`, return the index just past its matching `}`. */
function matchBrace(js, open) {
  let depth = 0;
  let i = open;
  while (i < js.length) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') {
      while (i < js.length && js[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      i += 2;
      while (i < js.length && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(js, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

const FN_RE = /^(async\s+)?function(\s+|\s*\*\s*)([A-Za-z_$][\w$]*)\s*\(/;

function matchFn(js, i) {
  // Must start a word: `myfunction foo()` is not a declaration.
  if (i > 0 && /[\w$.]/.test(js[i - 1])) return null;
  const m = FN_RE.exec(js.slice(i, i + 256));
  if (!m) return null;
  return { name: m[3], parenIdx: i + m[0].length - 1 };
}

function fnEnd(js, parenIdx) {
  let depth = 0;
  let i = parenIdx;
  while (i < js.length) {
    const c = js[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(js, i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  while (i < js.length && js[i] !== '{') i++;
  if (i >= js.length) return -1;
  return matchBrace(js, i);
}

/**
 * Split the methods section into top-level function declarations and everything
 * else.
 *
 * Function bodies are skipped whole, so nested functions are never mistaken for
 * top-level ones. Depth tracking covers the rarer case of a declaration inside a
 * top-level block.
 *
 * Known limitation: a regex literal containing an unbalanced brace or quote
 * (`/\{/`) can confuse the scan. Detecting regex-vs-division needs a full JS
 * tokenizer, which is not worth it here -- and the failure is loud, because the
 * emitted class fails to parse and surfaces as a compile error in the Console
 * rather than corrupting anything silently.
 */
function scanMethods(js) {
  const fns = [];
  const other = [];
  let i = 0;
  let cut = 0;
  let depth = 0;
  let paren = 0;

  while (i < js.length) {
    const c = js[i];

    if (c === '/' && js[i + 1] === '/') {
      while (i < js.length && js[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      i += 2;
      while (i < js.length && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(js, i);
      continue;
    }

    if (depth === 0 && paren === 0) {
      const m = matchFn(js, i);
      if (m) {
        const end = fnEnd(js, m.parenIdx);
        if (end < 0) {
          return { fns, other: other.join(''), error: `Unterminated function "${m.name}".` };
        }
        other.push(js.slice(cut, i));
        fns.push({ name: m.name, src: js.slice(i, end), line: countLines(js.slice(0, i)) + 1 });
        i = end;
        cut = end;
        continue;
      }
    }

    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }

  other.push(js.slice(cut));
  return { fns, other: other.join(''), error: null };
}

/**
 * `function use(a) {…}` -> `use(a) {…}`, i.e. a class method.
 *
 * This transform is the reason `super.use()` works. Only class methods and
 * shorthand object methods get a [[HomeObject]]; a plain function assigned onto a
 * prototype does not, and `super` inside it is a syntax error. Emitting real
 * class methods buys the entire inheritance story for free.
 */
function toMethod(src) {
  return src.replace(FN_RE, (_m, async_, sep, name) => {
    const star = sep.includes('*') ? '*' : '';
    return `${async_ ? 'async ' : ''}${star}${name}(`;
  });
}

/* -------------------------------------------------------------------------- */
/* Compile                                                                    */
/* -------------------------------------------------------------------------- */

class Diagnostics {
  constructor(file) {
    this.file = file;
    this.items = [];
  }
  error(message, line) {
    this.items.push({ severity: 'error', message, line, file: this.file });
  }
  warn(message, line) {
    this.items.push({ severity: 'warning', message, line, file: this.file });
  }
  get ok() {
    return !this.items.some((d) => d.severity === 'error');
  }
}

/**
 * @param {string} source  the full .ags.txt
 * @param {object} [opts]
 * @param {string} [opts.file] filename, for diagnostics
 * @param {boolean} [opts.defOnly] parse dat/def and skip emitting the class.
 *   The scheduler tables only need the def block, so a runtime loading a large
 *   scene can build them without paying for `new Function` on every script, then
 *   compile bodies on demand. This is the payoff of declaring run modes
 *   separately from the method bodies (DESIGN.md §6.4) -- the editor still
 *   compiles eagerly, because it wants diagnostics the moment you stop typing.
 * @returns {{
 *   ok: boolean, dat: object, def: object, methodNames: string[],
 *   factory: ((Base: Function) => Function) | null, diagnostics: object[]
 * }}
 */
export function compileAGS(source, { file = 'script.ags.txt', defOnly = false } = {}) {
  const diag = new Diagnostics(file);
  const dat = {};
  const def = { extends: null, name: null, runInfo: {} };

  const datMatch = DAT_RE.exec(source);
  const defMatch = DEF_RE.exec(source);

  if (!datMatch && !defMatch) {
    diag.error('No <?dat or <?def section found. An Angel Script needs at least one.', 1);
    return { ok: false, dat, def, methodNames: [], factory: null, diagnostics: diag.items };
  }

  /* -- dat --------------------------------------------------------------- */

  if (datMatch) {
    const baseLine = countLines(source.slice(0, datMatch.index)) + 1;
    try {
      const { forms, rest } = read(datMatch[1]);

      if (rest.trim()) {
        diag.error(`Unexpected text in dat section: "${rest.trim().slice(0, 30)}"`, baseLine);
      }

      for (const form of forms) {
        const key = formKey(form);
        if (!key) {
          diag.error('dat entries must look like (name value).', baseLine);
          continue;
        }
        if (key in dat) diag.warn(`Duplicate dat entry "${key}" — the later one wins.`, baseLine);

        // dat cannot shadow a built-in element property.
        //
        // The scene file always carries a value for every schema key, and the
        // scene wins -- so `(visible false)` in dat is silently ignored, and the
        // author is left wondering why their element is on screen. Say so.
        if (BASE_PROPERTIES.has(key)) {
          diag.warn(
            `(${key} …) has no effect — "${key}" is a built-in element property, and the ` +
              `scene's value always wins. Set it in the Properties panel, or from a method ` +
              `(this.${key} = …).`,
            baseLine,
          );
        }

        dat[key] = formValue(form);
      }
    } catch (err) {
      if (err instanceof ReadError) diag.error(err.message, baseLine + err.line - 1);
      else throw err;
    }
  }

  /* -- def --------------------------------------------------------------- */

  let methods = [];
  let other = '';

  if (defMatch) {
    const baseLine = countLines(source.slice(0, defMatch.index)) + 1;

    let forms = [];
    let rest = '';
    try {
      // The reader stops at the first non-`(` token; everything after is JS.
      ({ forms, rest } = read(defMatch[1]));
    } catch (err) {
      if (err instanceof ReadError) {
        diag.error(err.message, baseLine + err.line - 1);
        return { ok: false, dat, def, methodNames: [], factory: null, diagnostics: diag.items };
      }
      throw err;
    }

    for (const form of forms) {
      const key = formKey(form);
      const value = formValue(form);

      switch (key) {
        case 'extends':
          def.extends = String(value);
          break;
        case 'name':
          def.name = String(value);
          break;
        case 'runInfo': {
          const [method, ...rest2] = form.slice(1).map((v) => (v?.name ?? v));
          if (!method) {
            diag.error('(runInfo method value) needs a method name.', baseLine);
            break;
          }
          const raw = rest2.length === 1 ? rest2[0] : rest2;
          def.runInfo[String(method)] = (Array.isArray(raw) ? raw : [raw]).flat().map(String);
          break;
        }
        default:
          diag.warn(`Unknown def form "(${key} …)" — ignored.`, baseLine);
      }
    }

    const scan = scanMethods(rest);
    if (scan.error) {
      diag.error(scan.error, baseLine);
      return { ok: false, dat, def, methodNames: [], factory: null, diagnostics: diag.items };
    }
    methods = scan.fns;
    other = scan.other;

    // Declarations stranded in the JavaScript.
    //
    // The reader is greedy and stops at the first token that is not `(`, so once
    // a `function` appears everything after it is JavaScript -- and a later
    // `(runInfo …)` is parsed as JS, producing something like
    // "Unexpected identifier". That is a useless error for the mistake, and the
    // mistake is the NATURAL one: writing each runInfo next to the method it
    // describes is how anyone would want to write this. Name it precisely.
    //
    // Matched by form name rather than a leading `(`, so real JavaScript like
    // `(function(){})()` or `(a || b).c()` is never mistaken for a declaration.
    const stranded = STRANDED_RE.exec(other);
    if (stranded) {
      diag.error(
        `(${stranded[1]} …) appears after a function. Every dat/def declaration must come ` +
          `BEFORE the first function — the reader stops at the first token that isn't "(", ` +
          `and treats the rest as JavaScript. Move it up with the other declarations.`,
        baseLine + countLines(rest.slice(0, stranded.index)),
      );
      return { ok: false, dat, def, methodNames: [], factory: null, diagnostics: diag.items };
    }

    const lispComment = LISP_COMMENT_IN_JS_RE.exec(other);
    if (lispComment) {
      diag.error(
        `A ";" comment appears in the methods section. This file has two comment ` +
          `syntaxes: ";" in dat/def (LISP), "//" in the methods (JavaScript). Use "//" here.`,
        baseLine + countLines(rest.slice(0, lispComment.index)),
      );
      return { ok: false, dat, def, methodNames: [], factory: null, diagnostics: diag.items };
    }
  }

  const methodNames = methods.map((m) => m.name);

  /* -- validate ---------------------------------------------------------- */

  // The declaration table's one weakness is drifting from the methods on a
  // rename. Catching it at compile time is the entire reason to validate.
  //
  // But a file that `extends` something cannot be checked here: the method may
  // be inherited, and this compile knows nothing about the chain. Those are
  // re-validated against the real prototype in compileAll(), once the chain is
  // built. Erroring here would reject the correct, ordinary case of a subclass
  // re-scheduling a method it inherits.
  for (const [method, modes] of Object.entries(def.runInfo)) {
    if (!methodNames.includes(method) && !def.extends) {
      diag.error(
        `runInfo names "${method}", but no such method is defined. Renamed it?`,
        defMatch ? countLines(source.slice(0, defMatch.index)) + 1 : 1,
      );
    }
    for (const mode of modes) {
      if (!(mode in RUN_INFO)) {
        diag.error(
          `Unknown runInfo "${mode}" on "${method}". Valid: ${Object.keys(RUN_INFO).join(', ')}.`,
          1,
        );
      }
    }
  }

  const dupes = methodNames.filter((n, i) => methodNames.indexOf(n) !== i);
  for (const d of new Set(dupes)) diag.error(`Method "${d}" is defined more than once.`, 1);

  if (!diag.ok) {
    return { ok: false, dat, def, methodNames, factory: null, diagnostics: diag.items };
  }

  if (defOnly) {
    return { ok: true, dat, def, methodNames, factory: null, diagnostics: diag.items };
  }

  /* -- emit -------------------------------------------------------------- */

  const classBody = methods.map((m) => toMethod(m.src)).join('\n\n');
  const src = `"use strict";\n${other}\nreturn class extends __Base {\n${classBody}\n};`;

  let factory;
  try {
    // eslint-disable-next-line no-new-func
    const make = new Function('__Base', src);
    factory = (Base) => make(Base);
  } catch (err) {
    diag.error(`JavaScript error: ${err.message}`, 1);
    return { ok: false, dat, def, methodNames, factory: null, diagnostics: diag.items };
  }

  return { ok: true, dat, def, methodNames, factory, diagnostics: diag.items };
}

/** Resolve a method's run modes, applying defaults and the `void` alias. */
export function runModes(def, methodName) {
  const modes = def.runInfo?.[methodName] ?? [DEFAULT_RUN_INFO];
  // `void` is specified as an experimental null that the engine treats as onLoad.
  return modes.map((m) => (m === 'void' ? 'onLoad' : m));
}
