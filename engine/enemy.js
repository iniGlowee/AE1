/**
 * AE1 - Enemy (DESIGN.md §18.40): a COMBATANT NPC — a real animation state
 * machine and a selectable brain on top of the NPC chain (wander, health,
 * passive dialogue, hitbox, ground snap all inherited).
 *
 * `(extends Enemy)` on a skinned glb element whose file carries named clips
 * gives it:
 *
 *  - A CLIP-DRIVEN STATE MACHINE: `(idle)(move)(run)(attacks (…))(hit)
 *    (hitBig)(death)` name clips from the element's own glb (or animLibs).
 *    States crossfade through the renderer's mixer; one-shots (attacks, hit
 *    reactions, death) clamp on their last frame and report back through
 *    `onFinished`.
 *  - A BRAIN chosen by dat, all in one place here — scripts pick, not code:
 *      (aiType "melee")     sees the player inside `aggroRange`, chases at
 *                           `chaseSpeed`, swings a random `(attacks …)` clip
 *                           in reach, strikes once past `attackWindup` if the
 *                           target is still inside range and `attackArc`,
 *                           cools `attackRate` between swings, gives up past
 *                           `leashRange` and strolls home.
 *      (aiType "friendly")  never fights — the inherited wander, full stop.
 *  - `(friendlyUntilAttacked true)`: a melee brain that stays peaceful until
 *    the first `takeDamage` — then it remembers (`_provoked`) for life.
 *  - HIT REACTIONS: a non-fatal hit interrupts everything with the `(hit)`
 *    clip (`(hitBig)` when the blow is `bigHitDamage`+) and staggers the body
 *    for `hurtTime`/`hurtTimeBig` seconds. Fatal damage plays `(death)` once
 *    and holds the corpse until `vanishAfter` — no clip named falls back to
 *    the NPC topple.
 *
 * The NPC proximity swipe is retired here: with no `(attacks …)` clips the
 * melee brain degrades to the same instant-touch damage, but a real enemy
 * telegraphs. Enemy→player damage is distance + facing arc at the strike
 * moment (no weapon AABB: machines ARE the weapon).
 */

import { defineDatAccessors } from './element.js';
import { AE1NPC } from './npc.js';
import { turnToward } from './thirdperson.js';
import { AE1EnemyRound, AE1AoeWave } from './enemyattacks.js';

const ENEMY_DEG = Math.PI / 180; // unique name: the classic bundle shares one scope

export class AE1Enemy extends AE1NPC {
  _attacking = false;
  _attackT = 0;
  _struck = false;
  _cooldownT = 0;
  _hurtT = 0;
  _provoked = false;
  _engaged = false;
  _chaseBlocked = false;

  _enemyBegin() {
    this._npcBegin();
    this._provoked = false;
    this._engaged = false;
    // §18.46: a dat-tinted enemy pushes its color into the model component
    // (the renderer clones this instance's materials and multiplies) — the
    // same plumbing setTint() drives at runtime.
    if (this.tint) this.setComponent('model', 'tint', String(this.tint));
    // -- THE ATTACK TABLE (§18.44) ---------------------------------------- //
    // `(attackSpecs (( clip kind damage [key value]... ) ...))` classifies
    // each attack animation: kind ∈ melee | ranged | aoe1 (ring) | aoe2
    // (orb) — more kinds (guns, lasers, magic) are new branches in the
    // attacking tick, nothing else. A clip with no spec is a plain melee
    // swing at `(attackDamage)` — yesterday's enemies never notice this
    // system exists. Runtime-mutable via get/setAttackSpec/Damage, so an
    // AngelScript event can buff a whole mob's stomp with three lines.
    this._attackTable = {};
    const specs = this.attackSpecs;
    if (Array.isArray(specs)) {
      for (const row of specs) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [clip, kind, damage, ...rest] = row;
        const spec = { kind: String(kind), damage: Number(damage) || 0 };
        for (let i = 0; i + 1 < rest.length; i += 2) spec[String(rest[i])] = Number(rest[i + 1]);
        this._attackTable[String(clip)] = spec;
      }
    }
  }

  /* -- the attack-classification API (§18.44) ------------------------------ */

  _attackSpec(clip) {
    return (
      this._attackTable?.[clip] ?? { kind: 'melee', damage: Number(this.attackDamage) || 0 }
    );
  }

  /** A COPY of the clip's spec (kind, damage, extras), or null if unspecced. */
  getAttackSpec(clip) {
    return this._attackTable?.[clip] ? { ...this._attackTable[clip] } : null;
  }

  /** Merge fields into a clip's spec (creating it melee-default first) —
   *  `setAttackSpec("Attack_3", {damage: 12, radius: 9})`. */
  setAttackSpec(clip, patch) {
    const t = (this._attackTable ??= {});
    t[clip] = {
      kind: 'melee',
      damage: Number(this.attackDamage) || 0,
      ...(t[clip] ?? {}),
      ...(patch ?? {}),
    };
    return t[clip];
  }

  getAttackDamage(clip) {
    return Number(this._attackSpec(clip).damage) || 0;
  }

  setAttackDamage(clip, dmg) {
    return this.setAttackSpec(clip, { damage: Number(dmg) || 0 });
  }

  /** The COMBAT EVENT (§18.44): who, what, where, when, why, at whom —
   *  pushed onto `world.attackEvents` (the global feed anything may read
   *  each tick; last 32 kept) AND dispatched to the target's
   *  `onEnemyAttack (evt)` hook the moment the attack STARTS — the
   *  telegraph, not the impact, which is what dodging needs. */
  _dispatchAttackEvent(clip, spec, target) {
    const w = this.world;
    if (!w) return;
    const evt = {
      attacker: this,
      name: this.name,
      clip,
      kind: spec.kind,
      damage: Number(spec.damage) || 0,
      x: this.x ?? 0,
      y: this.y ?? 0,
      z: this.z ?? 0,
      t: w.loop?.elapsed ?? 0,
      state: this._animState,
      aiType: String(this.aiType || 'melee'),
      target: target ?? null,
    };
    (w.attackEvents ??= []).push(evt);
    if (w.attackEvents.length > 32) w.attackEvents.shift();
    if (target) w.loop?.dispatchTo(target, 'onEnemyAttack', evt);
  }

  /** One question, one place: does this thing fight on sight right now? */
  _isHostile() {
    if (this._dead) return false;
    if (String(this.aiType || 'melee') === 'friendly') return false;
    const fua = this.friendlyUntilAttacked === true || this.friendlyUntilAttacked === 'true';
    return fua ? this._provoked : true;
  }

  /** Damage provokes (forever), staggers (the hit clip interrupts even a
   *  mid-swing attack), and past zero the base class turns out the lights —
   *  `_npcAnimate('dead')` routes to the `(death)` clip below. */
  takeDamage(amount, from = null) {
    if (this._dead) return;
    this._provoked = true;
    const n = Math.max(0, Number(amount) || 0);
    super.takeDamage(amount, from);
    if (this._dead) return;
    const big = !!this.hitBig && n >= (Number(this.bigHitDamage) || 25);
    const clip = big ? this.hitBig : this.hit || this.hitBig;
    if (!clip) return; // no reaction clip: absorb it stoically
    this._endAttack(); // an interrupted swing still pays its cooldown
    this._hurtT = Math.max(0.2, Number(big ? this.hurtTimeBig : this.hurtTime) || (big ? 1.6 : 0.55));
    this._animState = 'hurt';
    this.playAnimation(String(clip), { loop: false, fade: 0.08 });
  }

  /** The state → clip routing. `chase` falls back to `move` (a machine with
   *  no run cycle hurries at a walk); `dead` plays the one-shot death and the
   *  mixer clamps its final frame — the corpse pose holds itself. */
  _npcAnimate(state) {
    if (state === this._animState) return;
    this._animState = state;
    if (state === 'dead') {
      if (this.death) this.playAnimation(String(this.death), { loop: false, fade: 0.12 });
      else this.setComponent('model', 'clip', '__bind__'); // the topple inherits
      return;
    }
    const clip =
      state === 'move' ? this.move
      : state === 'idle' ? this.idle
      : state === 'chase' ? this.run || this.move
      : '';
    if (clip) this.playAnimation(String(clip), { loop: true });
    else this.setComponent('model', 'clip', '__bind__');
  }

  /** FLIERS (§18.44): `(hoverHeight 2)` floats the ground snap — the em0030
   *  small flyer's whole locomotion is the same wander/chase brain at
   *  altitude. Death drops the hover: the machine falls out of the sky. */
  _groundSnap(dt) {
    const hover = this._dead ? 0 : Number(this.hoverHeight) || 0;
    if (!hover) return super._groundSnap(dt);
    const env = this.world?.env3d;
    if (!env?.groundAt) return;
    const x = this.x ?? 0;
    const z = this.z ?? 0;
    const y = this.y ?? 0;
    let g = env.groundAt(this, x, z, y + 0.5);
    if (g == null) g = env.groundAt(this, x, z, y + 3);
    if (g == null) return;
    const target = g + hover;
    const step = Math.max(0.05, 4 * dt);
    const d = target - y;
    this.y = Math.abs(d) > step ? y + Math.sign(d) * step : target;
  }

  /** Death with a clip needs no topple: the animation lies down, the ground
   *  snap keeps it on the floor, `vanishAfter` sweeps it away. */
  _tickDeath(dt) {
    if (!this.death) return super._tickDeath(dt);
    this._deadFor += dt;
    this._groundSnap(dt);
    if (this._deadFor >= (Number(this.vanishAfter) || 3)) {
      this.visible = false;
      this.pickable = false;
    }
  }

  _startAttack() {
    const v = this.attacks;
    const list =
      typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : Array.isArray(v) ? v.map(String) : [];
    if (!list.length) {
      // clip-less fallback: the old NPC swipe, instant and invisible
      this._cooldownT = Math.max(0.3, Number(this.attackRate) || 1.5);
      const p = this._findPlayer();
      if (p?.takeDamage) p.takeDamage(Number(this.attackDamage) || 0, this);
      return;
    }
    const clip = list[Math.floor(Math.random() * list.length)];
    const spec = this._attackSpec(clip);
    this._curAttack = { clip, ...spec };
    this._attacking = true;
    this._attackT = 0;
    this._struck = false;
    this._animState = 'attack';
    this.playAnimation(clip, { loop: false, fade: 0.15 });
    // The event fires at the TELEGRAPH, not the impact — dodging needs the
    // warning, and every effect system keys off the same moment (§18.44).
    this._dispatchAttackEvent(clip, spec, this._findPlayer());
  }

  /** RANGED (§18.44): one round toward the player's center as of the shot —
   *  straight flight, the reference action game orb convention. Spawned live; game3d's
   *  element-count rebuild loads the glb. */
  _spawnRound(p) {
    const scn = this.world?.scene;
    if (!scn) return;
    const spec = this._curAttack ?? {};
    const b = this.world?.env3d?.boundsOf?.(this);
    const ox = this.x ?? 0;
    const oy = b ? (b.min.y + b.max.y) / 2 : (this.y ?? 0) + 1;
    const oz = this.z ?? 0;
    let dir = { x: 0, y: 0, z: 1 };
    if (p) {
      const pb = this.world?.env3d?.boundsOf?.(p);
      const tx = pb ? (pb.min.x + pb.max.x) / 2 : (p.x ?? 0);
      const ty = pb ? (pb.min.y + pb.max.y) / 2 : (p.y ?? 0) + 0.9;
      const tz = pb ? (pb.min.z + pb.max.z) / 2 : (p.z ?? 0);
      const dx = tx - ox;
      const dy = ty - oy;
      const dz = tz - oz;
      const l = Math.hypot(dx, dy, dz) || 1;
      dir = { x: dx / l, y: dy / l, z: dz / l };
    }
    const el = new AE1EnemyRound({
      id: 'eround-' + Math.random().toString(36).slice(2, 10),
      name: '__EnemyRound',
      type: 'object',
      visible: true,
      x: ox + dir.x * 0.6,
      y: oy + dir.y * 0.6,
      z: oz + dir.z * 0.6,
      components: { model: { media: String(this.roundMedia || 'orange_orb.glb'), node: 'orange_orb' } },
    });
    el._dir = dir;
    el._speed = Number(spec.speed) || 5;
    el._damage = Number(spec.damage) || 5;
    el._attacker = this;
    el._range = Number(spec.range) || 30;
    scn.add(el);
    this.world?.loop?.rescan?.();
  }

  /** AOE (§18.44): the expanding wave — 'ring' (type 1, the stomp circle at
   *  ground level) or 'orb' (type 2, the translucent sphere from the attack
   *  point). Damage happens in the wave element when its FRONT passes the
   *  player; this just births it with the attack's numbers. */
  _spawnWave(mode) {
    const scn = this.world?.scene;
    if (!scn) return;
    const spec = this._curAttack ?? {};
    const b = this.world?.env3d?.boundsOf?.(this);
    const media =
      mode === 'ring' ? String(this.ringMedia || 'red_ring.glb') : String(this.orbMedia || 'aoe_orb.glb');
    const el = new AE1AoeWave({
      id: 'ewave-' + Math.random().toString(36).slice(2, 10),
      name: '__AoeWave',
      type: 'object',
      visible: true,
      x: this.x ?? 0,
      y: mode === 'ring' ? (this.y ?? 0) + 0.05 : b ? (b.min.y + b.max.y) / 2 : (this.y ?? 0) + 1,
      z: this.z ?? 0,
      scaleX: 0.1,
      scaleY: mode === 'ring' ? 1 : 0.1,
      scaleZ: 0.1,
      components: { model: { media, node: mode === 'ring' ? 'red_ring' : 'aoe_orb' } },
    });
    el._mode = mode;
    el._speed = Number(spec.speed) || 4;
    el._maxR = Number(spec.radius) || 7;
    el._damage = Number(spec.damage) || 6;
    el._attacker = this;
    scn.add(el);
    this.world?.loop?.rescan?.();
  }

  /** The rest starts when the swing ENDS — cooldown at start let a long clip
   *  outlive its own timer and every swing chained gaplessly into the next. */
  _endAttack() {
    if (!this._attacking) return;
    this._attacking = false;
    this._cooldownT = Math.max(0.3, Number(this.attackRate) || 1.5);
    this._animState = null; // whatever comes next re-plays cleanly
  }

  /** onFinished from the renderer: attacks hand the body back; a finished
   *  hit/death clip needs nothing (timers and clamping own those). */
  _enemyClipDone() {
    if (this._attacking) this._endAttack();
  }

  /** Is the bearing to (dx,dz) inside the strike cone? */
  _inArc(dx, dz) {
    const bearing = Math.atan2(dx, dz) / ENEMY_DEG + (Number(this.faceOffset) || 0);
    const d = ((((bearing - this._heading) % 360) + 540) % 360) - 180;
    return Math.abs(d) <= (Number(this.attackArc) || 80);
  }

  _enemyTick(dt) {
    if (this.world?.debugFlags?.AI_FREEZE) return; // §18.56 — the debug wall
    if (this._dead) return this._tickDeath(dt);

    this._cooldownT = Math.max(0, (this._cooldownT ?? 0) - dt);

    // -- staggered: the hit clip owns the body, feet planted ---------------- //
    if (this._hurtT > 0) {
      this._hurtT -= dt;
      if (this._hurtT <= 0) this._animState = null; // force a fresh pick
      this._groundSnap(dt);
      return;
    }

    const p = this._findPlayer();
    let dist = Infinity;
    let dx = 0;
    let dz = 0;
    if (p) {
      dx = (p.x ?? 0) - (this.x ?? 0);
      dz = (p.z ?? 0) - (this.z ?? 0);
      dist = Math.hypot(dx, dz);
    }

    // -- mid-swing: committed, facing slowly, one strike past the windup ---- //
    if (this._attacking) {
      this._attackT += dt;
      if (p) {
        const target = Math.atan2(dx, dz) / ENEMY_DEG + (Number(this.faceOffset) || 0);
        this._heading = turnToward(this._heading, target, 90 * dt);
        this._applyPose(0);
      }
      const windup = Number(this._curAttack?.windup ?? this.attackWindup) || 0.45;
      if (!this._struck && this._attackT >= windup) {
        const kind = this._curAttack?.kind ?? 'melee';
        if (kind === 'melee') {
          // MELEE (§18.44, Austin's rule): the striking mesh OVERLAPPING
          // yours IS the hit — the Hitbox AABB test, swept every frame past
          // the windup until it lands or the clip ends. Dodging out works.
          // The PAD is the swing's forward extension: render bounds are
          // BIND-pose boxes (GPU skinning never moves them), so a punch
          // that visibly reaches 1.7 m sits in a 0.9 m-deep box — pad by
          // ~a third of the reach (spec `pad` overrides) or short-armed
          // machines whiff forever at their own stopping distance.
          const pad =
            Number(this._curAttack?.pad) ||
            Math.max(0.45, (Number(this.attackRange) || 1.6) * 0.3);
          // NOT this.intersects(p): that asks the OTHER side for .bounds(),
          // and the player is a Model, not a Hitbox — it silently never hit.
          // Both boxes straight from the renderer instead.
          const a = this.world?.env3d?.boundsOf?.(this);
          const pb = p && this.world?.env3d?.boundsOf?.(p);
          // THE DECISION AND THE STRIKE MUST AGREE. The brain swings the
          // moment the target CENTER is within `attackRange` (see the reach
          // gate below), but bind-pose AABBs are SHALLOW in the facing axis,
          // so at that same distance the padded box can fall short — the melee
          // whiffed while the machine stood swinging in your face and only the
          // long-reach AoE ever landed (Austin's report). So a hit is the
          // padded box overlap OR the horizontal center within reach — always
          // gated by the VERTICAL band (`yBand`), so a ground creature still
          // can't punch a flyer hovering overhead, and dodging OUT of reach
          // (the whole point) still saves you.
          const yBand =
            a && pb ? a.min.y - pad <= pb.max.y && a.max.y + pad >= pb.min.y : true;
          const aabb =
            !!(a && pb) &&
            a.min.x - pad <= pb.max.x && a.max.x + pad >= pb.min.x &&
            a.min.y - pad <= pb.max.y && a.max.y + pad >= pb.min.y &&
            a.min.z - pad <= pb.max.z && a.max.z + pad >= pb.min.z;
          const reachHit = p && dist <= (Number(this.attackRange) || 1.6) * 1.15;
          const overlap = (aabb || reachHit) && yBand;
          if (p && typeof p.takeDamage === 'function' && overlap) {
            this._struck = true;
            p.takeDamage(Number(this._curAttack?.damage ?? this.attackDamage) || 0, this);
          }
        } else {
          // fire-and-forget kinds launch exactly once at the windup moment;
          // their spawned element owns the rest (travel, overlap, damage)
          this._struck = true;
          if (kind === 'ranged') this._spawnRound(p);
          else if (kind === 'aoe1') this._spawnWave('ring');
          else if (kind === 'aoe2') this._spawnWave('orb');
          // unknown kinds (future: guns, lasers, magic) fizzle loudly
          else console.warn(`[Enemy] ${this.name}: unknown attack kind "${kind}"`);
        }
      }
      if (this._attackT > (Number(this.attackTimeout) || 4)) this._endAttack(); // lost finish
      this._groundSnap(dt);
      return;
    }

    // -- the melee brain ---------------------------------------------------- //
    if (p && this._isHostile()) {
      const aggro = Number(this.aggroRange) || 8;
      const leash = Number(this.leashRange) > 0 ? Number(this.leashRange) : aggro * 2.5;
      if ((this._engaged && dist <= leash) || dist <= aggro) {
        this._engaged = true;
        this._waypoints.length = 0; // wandering is over
        const reach = Number(this.attackRange) || 1.6;
        const target = Math.atan2(dx, dz) / ENEMY_DEG + (Number(this.faceOffset) || 0);
        this._heading = turnToward(this._heading, target, 540 * dt);
        this._applyPose(0);
        if (dist <= reach) {
          if (this._cooldownT === 0) this._startAttack();
          else this._npcAnimate('idle'); // in reach, between swings
        } else {
          // chase: straight steering, the wander probe cadence for walls
          this._probeT = (this._probeT ?? 0) + dt;
          if (this._probeT > 0.4) {
            this._probeT = 0;
            const ahead = Math.min(dist, 1.2);
            this._chaseBlocked = !this._walkable(
              { x: this.x ?? 0, z: this.z ?? 0 },
              { x: (this.x ?? 0) + (dx / dist) * ahead, z: (this.z ?? 0) + (dz / dist) * ahead },
            );
          }
          if (!this._chaseBlocked) {
            const speed = Number(this.chaseSpeed) || 3;
            const stop = reach * 0.75;
            const step = Math.min(speed * dt, Math.max(0, dist - stop));
            this.x = (this.x ?? 0) + (dx / dist) * step;
            this.z = (this.z ?? 0) + (dz / dist) * step;
            this._npcAnimate('chase');
          } else {
            this._npcAnimate('idle'); // wall in the way: hold the glare (v1, no A*)
          }
        }
        this._groundSnap(dt);
        this._drawRoute();
        return;
      }
      this._engaged = false; // beyond the leash: cool off into the stroll
    }

    // -- nothing to fight: the inherited wander ----------------------------- //
    this._wanderTick(dt);
    this._groundSnap(dt);
    this._drawRoute();
  }
}

AE1Enemy.agsDef = {
  name: 'Enemy',
  extends: null,
  // Hand-built agsDefs do not merge up the chain (the NPC lesson): re-list
  // PassiveDialogue's _pvTick or every Enemy goes mute. _npcTick is REPLACED
  // by _enemyTick on purpose — never list both, or two brains fight.
  runInfo: {
    _enemyBegin: ['onLoad'],
    _enemyTick: ['onTick'],
    _pvTick: ['onTick'],
    _enemyClipDone: ['onFinished'],
  },
};

AE1Enemy.agsDat = {
  ...AE1NPC.agsDat,
  // -- the brain ---------------------------------------------------------- //
  aiType: 'melee', // 'melee' | 'friendly' — the behavior tree, picked by dat
  friendlyUntilAttacked: false,
  aggroRange: 8,
  leashRange: 0, // 0 = 2.5 × aggroRange
  chaseSpeed: 3,
  // -- attacks (attackRange/attackDamage/attackRate inherited; range is
  //    now melee REACH, and the swing telegraphs instead of touch-hurting) -- //
  attacks: [],
  // §18.44 THE CLASSIFICATION TABLE: (( clip kind damage [key value]... ))
  // kinds: melee | ranged (speed range) | aoe1 ring (speed radius) |
  // aoe2 orb (speed radius). Unspecced clips stay plain melee.
  attackSpecs: [],
  // fliers wander/chase at altitude; 0 = ground creature (everyone so far)
  hoverHeight: 0,
  // §18.46: CSS hex tint multiplied over this instance's textures ("" = none)
  tint: '',
  // the spawned attack visuals — DATS so the exporter ships the meshes
  roundMedia: 'orange_orb.glb',
  ringMedia: 'red_ring.glb',
  orbMedia: 'aoe_orb.glb',
  attackWindup: 0.45,
  attackArc: 80,
  attackTimeout: 4,
  // -- reactions ---------------------------------------------------------- //
  hit: '',
  hitBig: '',
  bigHitDamage: 25,
  hurtTime: 0.55,
  hurtTimeBig: 1.6,
  // -- extra states (idle/move inherited from NPC) ------------------------ //
  run: '',
  death: '',
  attackRange: 1.6,
};

defineDatAccessors(AE1Enemy);
