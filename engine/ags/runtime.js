/**
 * AE1 - Angel Script runtime: class building, inheritance chains, scheduling.
 *
 * Shared by the editor and the exported game (DESIGN.md, Principle 2).
 */

import { AE1Element, defineDatAccessor } from '../element.js';
import { AE1HudElement, AE1Inventory } from '../hud.js';
import { AE1SaveHandler } from '../savehandler.js';
import { AE1Text } from '../text.js';
import { AE1Button } from '../button.js';
import { AE1Video } from '../video.js';
import { AE1Sprite } from '../sprite.js';
import { AE1DialogueBox, AE1DialogueDelegate } from '../dialogue.js';
import { AE1Model } from '../model3d.js';
import { AE1Controller, AE1ThirdPersonCamera, AE1ThirdPersonCharacter } from '../thirdperson.js';
import { AE1TileMover } from '../tilemover.js';
import { AE1ElementGraph } from '../elementgraph.js';
import { AE1ClickMarker } from '../clickmarker.js';
import { AE1MouseCursor } from '../mousecursor.js';
import { AE1RSStats } from '../rsskills.js';
import { AE1GameHUD } from '../gamehud.js';
import { AE1Hitbox } from '../hitbox.js';
import { AE1Projectile } from '../projectile.js';
import { AE1NPC } from '../npc.js';
import { AE1Enemy } from '../enemy.js';
import { AE1PassiveDialogue } from '../passivedialogue.js';
import { AE1Skybox } from '../skybox.js';
import { AE1Ladder } from '../ladder.js';
import { AE1LockMarker } from '../lockmarker.js';
import { AE1EnemyRound, AE1AoeWave } from '../enemyattacks.js';
import { AE1PostFX } from '../postfx.js';
import { AE1Light } from '../light.js';
import { AE1CharacterCameraCurve, AE1CharacterCameraCourse } from '../cameracurve.js';
import { AE1TriggerBox } from '../triggerbox.js';
import { AE1Aircraft } from '../aircraft.js';
import { AE1FollowerPod } from '../followerpod.js';
import { AE1DebugMenu } from '../debugmenu.js';
import { AE1Ambience } from '../ambience.js';
import { AE1Particles } from '../particles.js';
import { AE1Scatter } from '../scatter.js';
import { AE1PerspectiveCamera } from '../perspectivecamera.js';
import { AE1AudioBackgroundMusicVolume, AE1AudioFXVolume } from '../audiovolumes.js';
import { compileAGS, runModes, RUN_INFO } from './compiler.js';

/**
 * Base classes an Angel Script may `extend` by name.
 *
 * This is why HUD elements needed no new machinery: `(extends Inventory)` runs
 * through the same chain resolution as `(extends Openable)`. An author cannot
 * tell which bases the engine ships and which they wrote, and should not have to
 * — this is the "hidden elements that act like interfaces" idea from the original
 * spec, working exactly as described.
 *
 * A project script may shadow one of these by naming itself the same; the script
 * wins, because the author is more specific than the engine.
 */
export const BUILTINS = {
  Element: AE1Element,
  HudElement: AE1HudElement,
  Inventory: AE1Inventory,
  SaveHandler: AE1SaveHandler,
  Text: AE1Text,
  Button: AE1Button,
  Video: AE1Video,
  Sprite: AE1Sprite,
  DialogueBox: AE1DialogueBox,
  DialogueDelegate: AE1DialogueDelegate,
  Model: AE1Model,
  Controller: AE1Controller,
  ThirdPersonCamera: AE1ThirdPersonCamera,
  ThirdPersonCharacter: AE1ThirdPersonCharacter,
  TileMover: AE1TileMover,
  ElementGraph: AE1ElementGraph,
  ClickMarker: AE1ClickMarker,
  MouseCursor: AE1MouseCursor,
  RSStats: AE1RSStats,
  GameHUD: AE1GameHUD,
  Hitbox: AE1Hitbox,
  Projectile: AE1Projectile,
  NPC: AE1NPC,
  Enemy: AE1Enemy,
  PassiveDialogue: AE1PassiveDialogue,
  Skybox: AE1Skybox,
  BackgroundAudioAmbience: AE1Ambience,
  Ambience: AE1Ambience, // legacy alias, pre-§18.34 scripts
  AudioBackgroundMusicVolume: AE1AudioBackgroundMusicVolume,
  AudioFXVolume: AE1AudioFXVolume,
  Particles: AE1Particles,
  Scatter: AE1Scatter,
  PerspectiveCamera: AE1PerspectiveCamera,
  Ladder: AE1Ladder,
  LockMarker: AE1LockMarker,
  EnemyRound: AE1EnemyRound,
  AoeWave: AE1AoeWave,
  PostFX: AE1PostFX,
  Light: AE1Light,
  CharacterCameraCurve: AE1CharacterCameraCurve,
  CharacterCameraCourse: AE1CharacterCameraCourse,
  TriggerBox: AE1TriggerBox,
  Aircraft: AE1Aircraft,
  FollowerPod: AE1FollowerPod,
  DebugMenu: AE1DebugMenu,
};

/**
 * Build the class for one compiled script on top of `Base`.
 *
 * dat is MERGED down the chain, so a Door extending Openable inherits Openable's
 * `locked` without redeclaring it. Data inheritance, for free, from the same
 * prototype chain that carries behaviour.
 */
export function buildClass(compiled, Base = AE1Element, { name } = {}) {
  const cls = compiled.factory(Base);

  cls.agsDat = { ...(Base.agsDat ?? {}), ...compiled.dat };

  // runInfo MERGES down the chain, exactly like dat.
  //
  // Without this, a subclass that inherits behaviour loses its scheduling: a
  // Cartman that `(extends Kid)` and defines no methods of its own had an empty
  // runInfo, so nothing registered for onClick and clicking him did NOTHING. The
  // class was correct, the methods were there, the compile was clean -- he simply
  // never got called. Inheriting behaviour has to mean inheriting when it runs.
  cls.agsDef = {
    ...compiled.def,
    runInfo: { ...(Base.agsDef?.runInfo ?? {}), ...compiled.def.runInfo },
  };
  cls.agsBase = Base;

  for (const key of Object.keys(cls.agsDat)) defineDatAccessor(cls.prototype, key);

  // Named for devtools and for AE1Element.toString(). An anonymous class in a
  // stack trace tells you nothing about which script threw.
  Object.defineProperty(cls, 'name', { value: name ?? compiled.def.name ?? 'AGSElement' });

  return cls;
}

/**
 * Compile a set of scripts into classes, resolving `extends` in dependency order.
 *
 * @param {Record<string, string>} sources  scriptName -> .ags.txt text
 * @returns {{ classes: Map<string, Function>, diagnostics: object[] }}
 */
export function compileAll(sources) {
  const compiled = new Map();
  const classes = new Map();
  const diagnostics = [];

  for (const [file, src] of Object.entries(sources)) {
    const result = compileAGS(src, { file });
    diagnostics.push(...result.diagnostics);
    if (result.ok) compiled.set(file, result);
  }

  /** Resolve a script name to the key another script would `extends`. */
  const byName = new Map();
  for (const [file, r] of compiled) {
    byName.set(file, file);
    byName.set(file.replace(/\.ags\.txt$/, ''), file);
    if (r.def.name) byName.set(r.def.name, file);
  }

  const building = new Set();

  function build(file) {
    if (classes.has(file)) return classes.get(file);

    const result = compiled.get(file);
    if (!result) return null;

    // A cycle would recurse until the stack dies, with a message naming none of
    // the scripts involved. Name them instead.
    if (building.has(file)) {
      diagnostics.push({
        severity: 'error',
        file,
        line: 1,
        message: `Inheritance cycle: ${[...building, file].join(' → ')}.`,
      });
      return null;
    }
    building.add(file);

    let Base = AE1Element;
    const parent = result.def.extends;

    if (parent) {
      let parentFile = byName.get(parent);

      // A script can never extend itself.
      //
      // This is not a hypothetical: the natural way to write an inventory is
      // `(name "Inventory")` + `(extends Inventory)`, meaning the BUILT-IN. But
      // `(name …)` registers in byName, so the lookup found the script itself and
      // reported an inheritance cycle — the script silently fell back to
      // AE1Element and lost everything Inventory gave it. Ignoring self here lets
      // the name resolve onward to the built-in, which is what was meant.
      if (parentFile === file) parentFile = undefined;

      if (parentFile) {
        // Otherwise a project script wins over a built-in of the same name: the
        // author is more specific than the engine.
        Base = build(parentFile) ?? AE1Element;
      } else if (BUILTINS[parent]) {
        Base = BUILTINS[parent];
      } else {
        diagnostics.push({
          severity: 'error',
          file,
          line: 1,
          message:
            `(extends ${parent}) — no script or built-in named "${parent}". ` +
            `Built-ins: ${Object.keys(BUILTINS).join(', ')}.`,
        });
      }
    }

    building.delete(file);

    let cls;
    try {
      cls = buildClass(result, Base, { name: result.def.name ?? file.replace(/\.ags\.txt$/, '') });
    } catch (err) {
      diagnostics.push({ severity: 'error', file, line: 1, message: `Class build failed: ${err.message}` });
      return null;
    }

    // Re-validate runInfo against the FULL chain.
    //
    // compileAGS can only see one file, so it skips this check for anything with
    // an `extends` -- the method might be inherited. Here the prototype is real,
    // so rename-drift is catchable again even across inheritance. This is the
    // half of the check that a per-file compile structurally cannot do.
    for (const method of Object.keys(result.def.runInfo ?? {})) {
      if (typeof cls.prototype[method] !== 'function') {
        diagnostics.push({
          severity: 'error',
          file,
          line: 1,
          message: `runInfo names "${method}", but no such method exists on ${cls.name} or anything it extends. Renamed it?`,
        });
      }
    }

    classes.set(file, cls);
    return cls;
  }

  for (const file of compiled.keys()) build(file);

  return { classes, diagnostics };
}

/**
 * Rebuild each element on its compiled class.
 *
 * This is the moment the abstraction lands: a plain AE1Element BECOMES a Door.
 * dat lands as instance properties, methods land on the prototype, the UUID stays
 * the id, the authored name stays the name -- exactly the abstraction over the JS
 * object system that AGS exists to provide (DESIGN.md §5).
 *
 * Lives in /engine, not the editor, because the exported game must rehydrate
 * identically. Two implementations would be two chances to disagree.
 *
 * @param {import('../scene.js').AE1Scene} scene
 * @param {Map<string, Function>} classes  script file -> compiled class
 * @param {Function} [DefaultBase]  class for elements with no script. The HUD
 *   passes AE1HudElement, so an unscripted HUD element is still a HUD element
 *   rather than silently demoting to a scene element on every reload.
 * @returns {boolean} whether anything changed
 */
export function rehydrate(scene, classes, DefaultBase = AE1Element) {
  let changed = false;

  for (const el of scene.all()) {
    let Wanted;

    if (el.script) {
      Wanted = classes.get(el.script);

      // NEVER downgrade an element because its script failed to compile.
      //
      // This cost a real data-loss bug: a typo dropped the element to plain
      // AE1Element, which knows nothing of the script's dat keys, so they
      // vanished from _props and the next save persisted a scene without them.
      // A broken script means "I cannot build a better class right now" -- never
      // "discard this element's state".
      if (!Wanted) continue;
    } else {
      Wanted = DefaultBase;
    }

    if (el.constructor === Wanted) continue;

    scene.replace(new Wanted(el.serialize()));
    changed = true;
  }

  return changed;
}

/**
 * Build the scheduler tables for a set of elements.
 *
 * FLAT ARRAYS, built once at load from the def blocks -- never an
 * iterate-every-element-and-check-per-frame. This is the difference between a
 * scene of 500 elements running at 60fps and not (DESIGN.md §7), and it is only
 * cheap because the format declares run modes separately from the method bodies.
 */
export function buildSchedule(elements) {
  const tables = Object.fromEntries(Object.keys(RUN_INFO).map((k) => [k, []]));
  tables.onLoad ??= [];

  for (const el of elements) {
    const def = el.constructor?.agsDef;
    if (!def) continue;

    for (const method of Object.keys(def.runInfo ?? {})) {
      if (typeof el[method] !== 'function') continue;
      for (const mode of runModes(def, method)) {
        (tables[mode] ??= []).push({ element: el, method });
      }
    }
  }

  return tables;
}

/** Fire every method registered for a mode. Never let one script kill the loop. */
export function dispatch(tables, mode, ...args) {
  const entries = tables[mode];
  if (!entries?.length) return [];

  const results = [];
  for (const { element, method } of entries) {
    try {
      results.push(element[method](...args));
    } catch (err) {
      console.error(`[ags] ${element.name}.${method}() threw during ${mode}:`, err);
    }
  }
  return results;
}
