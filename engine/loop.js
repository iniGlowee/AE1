/**
 * AE1 - the game loop.
 *
 * Lives in /engine because the exported game runs THIS loop, not a copy of it
 * (DESIGN.md, Principle 2). The editor's Play button and a shipped game are the
 * same code path; "plays in the editor, breaks in the export" has nowhere to hide.
 *
 * The loop owns dispatch and hit-testing. It does not own rendering -- the
 * viewport draws in the editor, the exported runtime draws in the game, and both
 * hand this loop the same scene.
 */

import { buildSchedule, dispatch } from './ags/runtime.js';

/**
 * Largest dt a single frame may report, in seconds.
 *
 * requestAnimationFrame stops firing in a background tab, so the frame after you
 * return reports the entire time you were away. Unclamped, that single dt teleports
 * every moving element across the map and detonates any physics. Every engine
 * clamps this; the game simply runs slow rather than exploding.
 */
const MAX_DT = 0.1;

export class GameLoop {
  /**
   * @param {object} source  an AE1Scene, or an AE1World.
   *
   *   A world contributes its scene AND its persistent HUD; a bare scene
   *   contributes itself. The loop normalises the two through `orderedElements()`
   *   and otherwise does not care which it was handed -- so the editor can drive
   *   a lone scene and the game can drive a whole world with no second loop.
   *
   * @param {object} [opts]
   * @param {(dt: number) => void} [opts.onFrame]  called after each tick
   * @param {(err: Error, el: object, method: string) => void} [opts.onError]
   */
  constructor(source, { onFrame, onError } = {}) {
    this.source = source;
    this.onFrame = onFrame ?? null;
    this.onError = onError ?? null;

    this.tables = null;
    this.running = false;
    this.frames = 0;
    this.elapsed = 0;

    this._raf = null;
    this._last = 0;
    this._hover = null;

    // -- TIME EFFECTS (§18.41, the combat-feel round) ----------------------- //
    // One chokepoint for the whole simulation: every dt the loop hands out
    // (element ticks, the motion matcher, the renderer's mixers via onFrame)
    // is scaled here, so hit stop and kill slow-mo bend EVERYTHING uniformly
    // — the UE global-time-dilation model. Effect clocks advance in REAL
    // time (they must outlive the freeze they cause); concurrent effects
    // combine by MINIMUM (the strongest freeze wins, nothing stacks).
    this.timeScale = 1; // steady-state author knob; effects layer under it
    this._timeFx = [];
    // HARD PAUSE (§18.56, the debug menu): while true, onTick dispatch stops
    // entirely — not dt=0 ticks, NO ticks, so held keys cannot queue actions
    // through a frozen frame. onFrame still runs every rAF: the scene keeps
    // presenting (the renderer's own pause stops its mixers) and input
    // edges keep clearing, so nothing leaks into the resume frame.
    this.paused = false;
  }

  /** HIT STOP: the fighting-game impact freeze — a near-stop for a few
   *  dozen milliseconds with a tiny ease-out so velocities don't pop.
   *  Fire on every landed melee hit; heavier hits hold longer. */
  hitStop(hold = 0.09, scale = 0.05) {
    this._pushFx(scale, hold, 0.05);
  }

  /** KILL SLOW-MO: drop the world to `scale` instantly, hold, then ease
   *  back over `ease` seconds — the finisher emphasis. */
  slowMo(hold = 0.75, scale = 0.15, ease = 0.4) {
    this._pushFx(scale, hold, ease);
  }

  _pushFx(scale, hold, ease) {
    if (this._timeFx.length > 8) this._timeFx.shift(); // mash guard
    this._timeFx.push({ scale, hold, ease, t: 0 });
  }

  /** Advance effect clocks by RAW dt and return the current world scale. */
  _timeFxScale(raw) {
    let s = Math.max(0, Number(this.timeScale) || 1);
    for (let i = this._timeFx.length - 1; i >= 0; i--) {
      const fx = this._timeFx[i];
      fx.t += raw;
      if (fx.t >= fx.hold + fx.ease) {
        this._timeFx.splice(i, 1);
        continue;
      }
      const k =
        fx.t <= fx.hold ? fx.scale : fx.scale + (1 - fx.scale) * ((fx.t - fx.hold) / fx.ease);
      s = Math.min(s, k);
    }
    return s;
  }

  /* -- lifecycle ----------------------------------------------------------- */

  /** Everything live, in paint order. Scene-or-world, normalised. */
  orderedElements() {
    if (typeof this.source.orderedElements === 'function') return this.source.orderedElements();
    return this.source.sorted(this.source.all());
  }

  /**
   * Build the tables and start ticking.
   *
   * Deliberately does NOT dispatch onLoad.
   *
   * Scene lifecycle belongs to whoever owns scenes -- the world, whose
   * goToScene() fires onUnload for the outgoing scene and onLoad for the
   * incoming one, and whose start() fires the HUD's onLoad once. When the loop
   * ALSO dispatched onLoad, every element in the entry scene got it twice: a
   * script playing a sound on load played it twice, a counter counted two. Two
   * owners for one responsibility is one owner too many.
   *
   * Driving a bare scene? Call `scene.load()` yourself, then `loop.start()`.
   */
  start() {
    if (this.running) return;

    // Built once, here -- never per frame. Flat arrays per run mode.
    this.tables = buildSchedule(this.orderedElements());
    this.frames = 0;
    this.elapsed = 0;
    this._hover = null;

    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  /**
   * Rebuild the schedule. Call when the live element set changes.
   *
   * The tables are flat arrays built ONCE at start() (and on goToScene), which is
   * what keeps the loop from iterating every element every frame. The cost of that
   * is they go stale the moment something is added or removed mid-play: a spawned
   * element renders perfectly and never receives a click or a tick. Silent, and
   * indistinguishable from a broken script -- the same shape as the runInfo bug
   * that made clicking a character do nothing (docs/engine/05-lessons.md).
   *
   * A no-op before start(), because start() builds them anyway.
   */
  rescan() {
    if (!this.tables) return;
    this.tables = buildSchedule(this.orderedElements());
  }

  /** Stop ticking. Does NOT dispatch onUnload — see start(). */
  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = null;

    // onExit IS the loop's to fire: hover is loop state, and the thing under the
    // cursor is genuinely no longer under it.
    if (this._hover) this.dispatchTo(this._hover, 'onExit');
    this._hover = null;
  }

  _tick = () => {
    if (!this.running) return;

    const now = performance.now();
    const raw = Math.min((now - this._last) / 1000, MAX_DT);
    this._last = now;
    // SIMULATION time: raw wall time bent by the active time effects. Input
    // events and effect clocks stay real; everything the dt reaches slows.
    const dt = raw * this._timeFxScale(raw);

    if (!this.paused) {
      this.elapsed += dt;
      this.frames++;
      this._safeDispatch('onTick', dt);
    }
    this.onFrame?.(this.paused ? 0 : dt);

    this._raf = requestAnimationFrame(this._tick);
  };

  /* -- input --------------------------------------------------------------- */

  /**
   * The element under a scene-space point, topmost first.
   *
   * Paint order reversed: you grab what you can see, not what is buried under it.
   */
  pick(x, y) {
    const all = this.orderedElements();
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (el.visible && el.containsPoint(x, y)) return el;
    }
    return null;
  }

  /**
   * The acting element. Gives `tags` a real job: tag an element `player` and it
   * becomes the actor every onClick receives.
   *
   * The fallback stub still answers has() from the world's inventory when there
   * is one, so a game with no tagged player element still has a working
   * `actor.has("brass_key")` -- the inventory is the source of truth, not the
   * element that happens to carry it.
   */
  get actor() {
    const tagged = this.orderedElements().find((e) => e.tags?.includes('player'));
    if (tagged) return tagged;

    const world = this.source.inventory !== undefined ? this.source : null;
    return {
      name: 'Player',
      tags: ['player'],
      has: (id) => world?.inventory?.has(id) ?? false,
    };
  }

  pointerDown(x, y) {
    const el = this.pick(x, y);
    if (el) this.dispatchTo(el, 'onClick', this.actor);
    return el;
  }

  pointerMove(x, y) {
    const el = this.pick(x, y);
    if (el === this._hover) return this._hover;

    // Enter/exit, not every-frame-while-over. Firing onHover per frame would make
    // it a second onTick, and leave authors no way to say "on entry".
    if (this._hover) this.dispatchTo(this._hover, 'onExit', this.actor);
    this._hover = el;
    if (el) this.dispatchTo(el, 'onHover', this.actor);

    return el;
  }

  pointerDrag(x, y) {
    const el = this.pick(x, y);
    if (el) this.dispatchTo(el, 'onDrag', x, y);
    return el;
  }

  /* -- dispatch ------------------------------------------------------------ */

  /** Fire one element's methods for a mode. */
  dispatchTo(element, mode, ...args) {
    const entries = this.tables?.[mode];
    if (!entries) return [];

    const out = [];
    for (const entry of entries) {
      if (entry.element !== element) continue;
      try {
        out.push(element[entry.method](...args));
      } catch (err) {
        this._report(err, element, entry.method, mode);
      }
    }
    return out;
  }

  _safeDispatch(mode, ...args) {
    if (!this.onError) return dispatch(this.tables, mode, ...args);

    for (const { element, method } of this.tables[mode] ?? []) {
      try {
        element[method](...args);
      } catch (err) {
        this._report(err, element, method, mode);
      }
    }
  }

  /**
   * One bad script costs that element, never the game.
   *
   * A thrown onTick must not stop the loop -- an unplayable game is a far worse
   * failure than one misbehaving door, and the author needs the game running to
   * debug the door at all.
   */
  _report(err, element, method, mode) {
    if (this.onError) this.onError(err, element, method, mode);
    else console.error(`[ags] ${element?.name}.${method}() threw during ${mode}:`, err);
  }
}
