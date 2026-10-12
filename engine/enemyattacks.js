/**
 * AE1 - Enemy attack elements (§18.44): the SPAWNED halves of the attack
 * archetype system. `AE1Enemy` classifies its attacks (attackSpecs); when a
 * ranged or AOE attack passes its windup, it spawns one of these into the
 * live scene (the LockMarker precedent — game3d notices the element count
 * and loads the glb; no authoring, no pre-placement).
 *
 *  - `EnemyRound`: the projectile — today an orange orb (orange_orb.glb),
 *    tomorrow the reference game's glowing red spheres. Travels a straight line at its
 *    attack's speed; overlapping the PLAYER pops it and deals its attack's
 *    damage. It never hurts other enemies (the reference action game orbs don't friendly-fire),
 *    which is why this is not AE1Projectile — that class serves the player
 *    and hits everything with takeDamage.
 *  - `AoeWave`: the expanding area denial. `ring` mode (AOE TYPE 1) is the
 *    red circle racing outward at ground level from a stomp; `orb` mode
 *    (AOE TYPE 2) is the thin translucent sphere growing from the attack
 *    point. Either damages the player ONCE, when the wave FRONT passes
 *    through them — standing inside the ring after it passed is safe,
 *    exactly like the games these come from.
 *
 * Both are dumb on purpose: who/what/how-much arrives from the attacker's
 * spec at spawn; these just move, test, and leave. Damage numbers live in
 * the enemy's attack table (get/setAttackDamage) — never here.
 */

import { AE1Element, defineDatAccessors } from './element.js';

function findPlayer(scn) {
  return scn?.all().find((e) => e._inv && typeof e.equipIndex === 'function') ?? null;
}

function playerCenter(world, p) {
  const b = world?.env3d?.boundsOf?.(p);
  if (b) {
    return {
      x: (b.min.x + b.max.x) / 2,
      y: (b.min.y + b.max.y) / 2,
      z: (b.min.z + b.max.z) / 2,
      pad: Math.max(0.3, (b.max.x - b.min.x) / 2),
    };
  }
  return { x: p.x ?? 0, y: (p.y ?? 0) + 0.9, z: p.z ?? 0, pad: 0.45 };
}

export class AE1EnemyRound extends AE1Element {
  _dir = { x: 0, y: 0, z: 1 };
  _speed = 5;
  _damage = 5;
  _attacker = null;
  _range = 30;
  _flown = 0;

  _roundTick(dt) {
    const scn = this.world?.scene;
    if (!scn) return;
    const step = this._speed * dt;
    this.x = (this.x ?? 0) + this._dir.x * step;
    this.y = (this.y ?? 0) + this._dir.y * step;
    this.z = (this.z ?? 0) + this._dir.z * step;
    this._flown += step;
    this.rotationY = ((this.rotationY ?? 0) + 240 * dt) % 360; // a live thing
    const p = findPlayer(scn);
    if (p) {
      const c = playerCenter(this.world, p);
      const rr = c.pad + 0.2; // orb radius ~0.18 + a kind margin
      const dx = (this.x ?? 0) - c.x;
      const dy = (this.y ?? 0) - c.y;
      const dz = (this.z ?? 0) - c.z;
      if (dx * dx + dz * dz <= rr * rr && Math.abs(dy) <= 1.1) {
        if (typeof p.takeDamage === 'function') p.takeDamage(this._damage, this._attacker ?? this);
        return this._pop();
      }
    }
    if (this._flown >= this._range) this._pop();
  }

  _pop() {
    this.world?.scene?.remove?.(this.id);
    this.world?.loop?.rescan?.();
  }
}

AE1EnemyRound.agsDef = {
  name: 'EnemyRound',
  extends: null,
  runInfo: { _roundTick: ['onTick'] },
};

AE1EnemyRound.agsDat = {};

defineDatAccessors(AE1EnemyRound);

export class AE1AoeWave extends AE1Element {
  _mode = 'ring'; // 'ring' (AOE type 1) | 'orb' (AOE type 2)
  _speed = 4; // m/s of radius growth
  _maxR = 7;
  _damage = 6;
  _attacker = null;
  _r = 0.1;
  _hitDone = false;
  // FRIENDLY wave (§18.52): spawned by the PLAYER'S aircraft — damages
  // everything with takeDamage EXCEPT the player, each target once as the
  // front passes. The enemy-owned wave stays player-only, as authored.
  _friendly = false;
  _hitIds = null;

  _waveTick(dt) {
    const scn = this.world?.scene;
    if (!scn) return;
    this._r += this._speed * dt;
    const s = this._r; // the glbs are forged at radius 1
    this.scaleX = s;
    this.scaleZ = s;
    this.scaleY = this._mode === 'orb' ? s : 1;
    if (this._friendly) {
      const band = Math.max(0.8, this._speed * dt * 3);
      this._hitIds ??= new Set();
      for (const el of scn.all()) {
        if (el === this || el === this._attacker || typeof el.takeDamage !== 'function') continue;
        if (el._dead || this._hitIds.has(el.id)) continue;
        if (el._inv && typeof el.equipIndex === 'function') continue; // never the player
        const b = this.world?.env3d?.boundsOf?.(el);
        const cx = b ? (b.min.x + b.max.x) / 2 : el.x ?? 0;
        const cy = b ? (b.min.y + b.max.y) / 2 : (el.y ?? 0) + 0.9;
        const cz = b ? (b.min.z + b.max.z) / 2 : el.z ?? 0;
        const dx = cx - (this.x ?? 0);
        const dz = cz - (this.z ?? 0);
        const d = this._mode === 'ring'
          ? Math.hypot(dx, dz)
          : Math.hypot(dx, cy - (this.y ?? 0), dz);
        const heightOk = this._mode === 'orb' || Math.abs(cy - (this.y ?? 0)) < 2.2;
        if (d <= this._r && d >= this._r - band && heightOk) {
          this._hitIds.add(el.id);
          el.takeDamage(this._damage, this._attacker ?? this);
        }
      }
      if (this._r >= this._maxR) {
        this.world?.scene?.remove?.(this.id);
        this.world?.loop?.rescan?.();
      }
      return;
    }
    const p = findPlayer(scn);
    if (p && !this._hitDone) {
      const c = playerCenter(this.world, p);
      const dx = c.x - (this.x ?? 0);
      const dz = c.z - (this.z ?? 0);
      const band = Math.max(0.8, this._speed * dt * 3); // the passing FRONT
      let inFront = false;
      if (this._mode === 'ring') {
        const d = Math.hypot(dx, dz);
        inFront = d <= this._r && d >= this._r - band && Math.abs(c.y - (this.y ?? 0)) < 2.2;
      } else {
        const d = Math.hypot(dx, c.y - (this.y ?? 0), dz);
        inFront = d <= this._r && d >= this._r - band;
      }
      if (inFront) {
        this._hitDone = true; // the wave passed; behind it is safe
        if (typeof p.takeDamage === 'function') p.takeDamage(this._damage, this._attacker ?? this);
      }
    }
    if (this._r >= this._maxR) {
      this.world?.scene?.remove?.(this.id);
      this.world?.loop?.rescan?.();
    }
  }
}

AE1AoeWave.agsDef = {
  name: 'AoeWave',
  extends: null,
  runInfo: { _waveTick: ['onTick'] },
};

AE1AoeWave.agsDat = {};

defineDatAccessors(AE1AoeWave);
