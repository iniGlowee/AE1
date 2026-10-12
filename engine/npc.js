/**
 * AE1 - NPC: a wandering, killable inhabitant (DESIGN.md §18.12).
 *
 * `(extends NPC)` on a decomposed glb element gives it:
 *
 *  - WANDER: a queue of random waypoints inside `wanderRange` of its spawn,
 *    walked at `wanderSpeed`, facing its travel (the same world-yaw-over-rest
 *    composition as the player — baked armature rotations stay upright).
 *  - A PATH you can SEE: with `(drawPaths true)` the planned route is written
 *    to the element's `debug.path` component and the renderer draws it as a
 *    line. Flip the flag in dat; no code.
 *  - HEALTH: `(health 99)`. `takeDamage(n, from)` subtracts, dispatches
 *    `onHit` (mode) to the NPC's script, and at zero the body TOPPLES — no
 *    death animation exists, so physics is the animation: it tips over,
 *    settles on the ground, and vanishes `vanishAfter` seconds later.
 *  - The Hitbox chain: an invisible volume, so the player's E reaches it
 *    (`onInteract`) and a weapon swing can collide with it (§18.11).
 *
 * No three.js; geometry questions go through `world.env3d` like everyone else.
 */

import { defineDatAccessors } from './element.js';
import { AE1PassiveDialogue, emitVoice } from './passivedialogue.js';
import { qFromEulerXYZ, qMul, qYaw, qTwistYDeg, qToEulerXYZ, turnToward } from './thirdperson.js';

const NPC_DEG = Math.PI / 180; // not DEG: the classic bundle shares one scope with thirdperson.js

// NPC extends PASSIVE DIALOGUE (§18.21) — which extends Hitbox, so nothing is
// lost: every NPC can chat by proximity with zero extra wiring. dat-driven and
// dormant without `(passiveLines …)`; `_pvTick` already refuses to speak for
// the dead, so a toppled machine goes quiet on its own.
export class AE1NPC extends AE1PassiveDialogue {
  _dead = false;
  _deadFor = 0; // seconds since death
  _tip = 0; // topple angle, degrees
  _waypoints = []; // [{x,z}...] the planned route
  _heading = 0;

  /** Lose health (dat, so scripts and the panel see it live). At zero the
   *  body falls; `onHit` fires either way. */
  takeDamage(amount, from = null) {
    if (this._dead) return;
    const n = Math.max(0, Number(amount) || 0);
    this.health = (Number(this.health) || 0) - n; // the generated dat accessor
    this.world?.loop?.dispatchTo(this, 'onHit', from, n);
    if ((Number(this.health) || 0) <= 0) {
      this._dead = true;
      this._deadFor = 0;
      this.setComponent('debug', 'path', null); // the route dies with it
      this._npcAnimate('dead'); // rest pose: the TOPPLE is the death animation
      this._deathCry();
    }
  }

  _npcBegin() {
    this._home = { x: this.x ?? 0, z: this.z ?? 0 };
    this._qrest = qFromEulerXYZ(this.rotationX ?? 0, this.rotationY ?? 0, this.rotation ?? 0);
    this._h0 = qTwistYDeg(this._qrest);
    this._heading = this._h0;
    // dat -> component, the Model pattern: the renderer resolves clips through
    // the libraries only from the component (§18.10). Single-string collapse
    // normalised, the reader trap.
    const v = this.animLibs;
    const libs = typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map(String) : [];
    if (libs.length) this.setComponent('model', 'libs', libs);
    this._animState = null;
    this._npcAnimate('idle');
  }

  /** The NPC's little state machine: the `(move …)` clip while a leg is
   *  underfoot, the `(idle …)` clip at stops — or the REST POSE when no clip
   *  is named, pinned explicitly: with libraries attached, an empty clip
   *  resolves to first-anywhere and a stopped NPC would walk in place.
   *  Death always rests — the topple is the animation (§18.12). */
  _npcAnimate(state) {
    if (state === this._animState) return;
    this._animState = state;
    const clip = state === 'move' ? this.move : state === 'idle' ? this.idle : '';
    if (clip) this.playAnimation(String(clip), { loop: true });
    else this.setComponent('model', 'clip', '__bind__');
  }

  /** Is `to` a walkable waypoint from `from`? It needs GROUND beneath it (no
   *  strolling off the world) and a clear straight line (no walking into
   *  furniture). Both questions go to the renderer through env3d. */
  _walkable(from, to) {
    const env = this.world?.env3d;
    if (env?.groundAt && env.groundAt(this, to.x, to.z, (this.y ?? 0) + 1) == null) return false;
    if (env?.blocked && env.blocked(this, from.x, from.z, to.x, to.z, (this.y ?? 0) + 0.4)) return false;
    return true;
  }

  _npcTick(dt) {
    if (this._dead) return this._tickDeath(dt);

    this._wanderTick(dt);

    // -- the ground, like everyone ----------------------------------------- //
    this._groundSnap(dt);

    // -- the swipe (§18.28): an NPC with (attackRange > 0) HURTS ------------ //
    // No chase, no windup — he roams, and a player who lingers inside his
    // reach takes (attackDamage) every (attackRate) seconds. Opt-in by dat:
    // existing NPCs (range 0) never touch anyone.
    const range = Number(this.attackRange) || 0;
    if (range > 0) {
      this._atkT = Math.max(0, (this._atkT ?? 0) - dt);
      const p = this._findPlayer();
      if (p && this._atkT === 0) {
        const d = Math.hypot((p.x ?? 0) - (this.x ?? 0), (p.z ?? 0) - (this.z ?? 0));
        if (d <= range && typeof p.takeDamage === 'function') {
          this._atkT = Math.max(0.3, Number(this.attackRate) || 1.5);
          p.takeDamage(Number(this.attackDamage) || 0, this);
        }
      }
    }

    this._drawRoute();
  }

  /** The player, cached: PassiveDialogue may have found them already; a
   *  silent NPC (no lines) looks them up itself. */
  _findPlayer() {
    if (this._pvPlayer === undefined) {
      this._pvPlayer =
        this.world?.scene?.all().find((e) => typeof e.takeDamage === 'function' && e._tpcTick) ?? null;
    }
    return this._pvPlayer;
  }

  /** WANDER, factored out of the tick so subclasses with richer brains
   *  (AE1Enemy) can fall back to it verbatim when nothing is hostile. */
  _wanderTick(dt) {
    // DEBUG FREEZE: `(wander false)` — live-togglable in Properties — stops
    // the legs and the planner both: route dropped, path ink cleared, idle
    // pose. Ground snap, health, and passive dialogue keep running; flip it
    // back and he replans from wherever he stands (§18.21).
    const wandering = !(this.wander === false || this.wander === 'false');
    if (!wandering) {
      if (this._waypoints.length) this._waypoints.length = 0;
      this._npcAnimate('idle');
    } else if ((this._pauseFor ?? 0) > 0) {
      // -- idling at a stop ------------------------------------------------- //
      this._pauseFor -= dt;
      this._npcAnimate('idle');
    } else {
      // -- the route: keep three VALIDATED waypoints ahead ------------------ //
      // Candidates with no mesh under them or a mesh in the way are REDRAWN
      // (rejected and re-rolled) — a bounded number of tries per tick, so a
      // cramped corner never stalls the frame; next tick tries again.
      const range = Number(this.wanderRange) || 5;
      let tries = 0;
      while (this._waypoints.length < 3 && tries++ < 20) {
        const a = Math.random() * 360 * NPC_DEG;
        const r = (0.3 + Math.random() * 0.7) * range;
        const c = {
          x: (this._home?.x ?? 0) + Math.sin(a) * r,
          z: (this._home?.z ?? 0) + Math.cos(a) * r,
        };
        const from = this._waypoints.length
          ? this._waypoints[this._waypoints.length - 1]
          : { x: this.x ?? 0, z: this.z ?? 0 };
        if (this._walkable(from, c)) this._waypoints.push(c);
      }

      // -- walk it ---------------------------------------------------------- //
      const wp = this._waypoints[0];
      if (wp) {
        const dx = wp.x - (this.x ?? 0);
        const dz = wp.z - (this.z ?? 0);
        const dist = Math.hypot(dx, dz);
        if (dist < 0.15) {
          this._waypoints.shift();
          // Sometimes a stop is the point: linger, look around (in spirit).
          // Only a rolled pause switches the clip — a passed-through waypoint
          // stays in 'move', else every corner would flap walk→idle→walk.
          if (Math.random() < (Number(this.idleChance) || 0)) {
            this._pauseFor = 0.4 + Math.random() * (Number(this.idleTime) || 2);
            this._npcAnimate('idle');
          }
        } else {
          // The world moves: re-probe the CURRENT leg every so often, and if
          // something now stands in it, throw the WHOLE route away and replan
          // from here. Dropping just one leg made the NEXT waypoint the
          // target across a line nobody ever validated — near an obstacle
          // that churned bad leg after bad leg.
          this._probeT = (this._probeT ?? 0) + dt;
          if (this._probeT > 0.4) {
            this._probeT = 0;
            if (!this._walkable({ x: this.x ?? 0, z: this.z ?? 0 }, wp)) {
              this._waypoints.length = 0;
              this._applyPose(0);
              return;
            }
          }
          const speed = Number(this.wanderSpeed) || 1;
          this.x = (this.x ?? 0) + (dx / dist) * speed * dt;
          this.z = (this.z ?? 0) + (dz / dist) * speed * dt;
          const target = Math.atan2(dx, dz) / NPC_DEG + (Number(this.faceOffset) || 0);
          this._heading = turnToward(this._heading, target, 360 * dt);
          this._applyPose(0);
          this._npcAnimate('move');
        }
      } else {
        this._npcAnimate('idle'); // no route yet (or none walkable): stand
      }
    }
  }

  /** Show the planned route while `(drawPaths true)` and wandering. */
  _drawRoute() {
    const wandering = !(this.wander === false || this.wander === 'false');
    if (wandering && (this.drawPaths === true || this.drawPaths === 'true')) {
      const pts = [this.x ?? 0, (this.y ?? 0) + 0.05, this.z ?? 0];
      for (const p of this._waypoints) pts.push(p.x, (this.y ?? 0) + 0.05, p.z);
      this.setComponent('debug', 'path', pts);
    } else if (this.components?.debug?.path) {
      this.setComponent('debug', 'path', null);
    }
  }

  /** The DEATH tree (§18.21): an EVENT sound, so it differs from the passive
   *  tree on purpose — no silence roll, and it does not wait for another
   *  voice to finish (a death cry is diegetic; it happens WHEN it happens).
   *  One entry today; add more to `(deathSounds …)` and one is picked. */
  _deathCry() {
    const v = this.deathSounds;
    const list = typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map(String) : [];
    if (!list.length) return;
    const pick = list[Math.floor(Math.random() * list.length)];
    const volume = Math.max(0, Math.min(1, Number(this.passiveVolume ?? 1)));
    emitVoice(this, pick, { volume }); // tagged in world.voices like every voice
  }

  /** Death without an animation: PHYSICS is the animation. The body tips
   *  over (a lerp to lying), rests on the floor, then vanishes. */
  /**
   * Follow the ground, resiliently (the goober lesson, §18.21): the short ray
   * (feet + 0.5) follows slopes without climbing onto furniture, but if the
   * feet ever end up UNDER the floor it sees nothing forever — so a miss
   * retries from head height. And a snap is a STEP, never a teleport: the
   * per-tick change is clamped, so one garbage answer (a half-built scene, a
   * seam) nudges him instead of burying him.
   */
  _groundSnap(dt) {
    const env = this.world?.env3d;
    if (!env?.groundAt) return;
    const x = this.x ?? 0;
    const z = this.z ?? 0;
    const y = this.y ?? 0;
    let g = env.groundAt(this, x, z, y + 0.5);
    if (g == null) g = env.groundAt(this, x, z, y + 3);
    if (g == null) return;
    const step = Math.max(0.05, 6 * dt); // plenty for any walkable slope
    const d = g - y;
    this.y = Math.abs(d) > step ? y + Math.sign(d) * step : g;
  }

  _tickDeath(dt) {
    this._deadFor += dt;
    if (this._tip < 90) {
      this._tip = Math.min(90, this._tip + 160 * dt); // a heavy fall, ~0.6 s
      this._applyPose(this._tip);
    }
    this._groundSnap(dt);
    if (this._deadFor >= (Number(this.vanishAfter) || 3)) {
      this.visible = false;
      this.pickable = false;
    }
  }

  /** World yaw (and, dying, a world-axis topple) composed onto the rest
   *  orientation — the same rule as the player: never bare euler writes. */
  _applyPose(tipDeg) {
    let q = qMul(qYaw((this._heading ?? 0) - (this._h0 ?? 0)), this._qrest ?? qFromEulerXYZ(0, 0, 0));
    if (tipDeg) q = qMul(qFromEulerXYZ(tipDeg, 0, 0), q);
    const e = qToEulerXYZ(q);
    this.rotationX = e.x;
    this.rotationY = e.y;
    this.rotation = e.z;
  }
}

AE1NPC.agsDef = {
  name: 'NPC',
  extends: null,
  // _pvTick is PassiveDialogue's: hand-built agsDefs do not merge up the
  // chain the way compiled ones do (the ThirdPersonCharacter precedent) —
  // omit it and every NPC silently loses its proximity chatter.
  runInfo: { _npcBegin: ['onLoad'], _npcTick: ['onTick'], _pvTick: ['onTick'] },
};

AE1NPC.agsDat = {
  ...AE1PassiveDialogue.agsDat,
  pickable: false, // an enemy is interacted with, never pocketed
  health: 99,
  wanderSpeed: 1,
  wanderRange: 5,
  faceOffset: 0,
  drawPaths: false,
  // The debug freeze: false stops walking AND route planning/drawing, live.
  wander: true,
  vanishAfter: 3,
  hasPhysics: true,
  // Idling at waypoints: the chance a stop lingers, and up to how long (s).
  idleChance: 0.35,
  idleTime: 2,
  // The walk machine (§18.10 addressing: clips BY FILE through animLibs).
  // Empty idle/move = the rest pose for that state.
  animLibs: [],
  move: '',
  idle: '',
  // The death EVENT tree (§18.21): always plays one, no silence roll.
  deathSounds: [],
  // The swipe (§18.28): range 0 = harmless (every NPC until now). A player
  // inside attackRange takes attackDamage every attackRate seconds.
  attackRange: 0,
  attackDamage: 0,
  attackRate: 1.5,
};

defineDatAccessors(AE1NPC);
