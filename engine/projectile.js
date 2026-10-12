/**
 * AE1 - Projectile: a fired thing (DESIGN.md §18.15).
 *
 * `(extends Projectile)` on a mesh element makes it AMMUNITION. The element in
 * the scene is the TEMPLATE — a weapon names it (`(projectile "MIssile")`),
 * the Outliner hides it while assigned, and firing SPAWNS a fresh round from
 * it mid-animation (`projectileAt`, a fraction of the attack clip). Rounds:
 *
 *   (speed 14)          ; launch speed, m/s
 *   (acceleration 10)   ; m/s² along the flight — rockets get faster
 *   (range 40)          ; metres travelled before it expires
 *   (damage 90)         ; what it does to a health pool it enters
 *   (drawPaths true)    ; draw the flight trail (the debug.path renderer)
 *   (faceOffset 0)      ; degrees, for meshes authored nose-elsewhere
 *
 * A round flies straight along the shooter's facing, accelerating, dealing
 * its damage to the first Hitbox volume it enters, and REMOVES itself at the
 * end of its range. The template never flies; in play it hides at load.
 */

import { defineDatAccessors } from './element.js';
import { AE1Hitbox } from './hitbox.js';
import { qFromEulerXYZ, qMul, qYaw, qTwistYDeg, qToEulerXYZ } from './thirdperson.js';

const PROJ_DEG = Math.PI / 180; // not DEG: the classic bundle shares one scope

export class AE1Projectile extends AE1Hitbox {
  _flying = false;
  _spawned = false; // true on fired rounds, never on the template

  /** Fire this round from `from` along unit direction `dir`. */
  launch(from, dir, shooter = null) {
    this.x = from.x;
    this.y = from.y;
    this.z = from.z;
    this._dir = dir;
    this._vel = Number(this.speed) || 10;
    this._dist = 0;
    this._trail = [from.x, from.y, from.z];
    this._shooter = shooter;
    this._flying = true;
    this.visible = true;
    // Nose along the flight: world yaw over the rest orientation, the same
    // rule as every facing in AE1 (never bare euler writes) — then PITCH
    // about the yawed frame's right axis, so a shot converging up or down on
    // the focal point flies nose-first (§18.16).
    const qrest = qFromEulerXYZ(this.rotationX ?? 0, this.rotationY ?? 0, this.rotation ?? 0);
    const h0 = qTwistYDeg(qrest);
    const heading = Math.atan2(dir.x, dir.z) / PROJ_DEG + (Number(this.faceOffset) || 0);
    let q = qMul(qYaw(heading - h0), qrest);
    const elev = Math.atan2(dir.y ?? 0, Math.hypot(dir.x, dir.z)); // radians up
    if (Math.abs(elev) > 1e-4) {
      // Right axis of the yawed body, world frame: Ry(heading)·(1,0,0).
      const hr = heading * PROJ_DEG;
      const half = -elev / 2; // rotating z-forward about +right by −elev noses UP
      const s = Math.sin(half);
      q = qMul({ x: Math.cos(hr) * s, y: 0, z: -Math.sin(hr) * s, w: Math.cos(half) }, q);
    }
    const e = qToEulerXYZ(q);
    this.rotationX = e.x;
    this.rotationY = e.y;
    this.rotation = e.z;
  }

  _projBegin() {
    // The template is a mold, not a prop: hidden the moment play starts.
    if (!this._spawned) this.visible = false;
  }

  _projTick(dt) {
    if (!this._flying) return;

    const px = this.x ?? 0, py = this.y ?? 0, pz = this.z ?? 0;
    this._vel += (Number(this.acceleration) || 0) * dt;
    const step = this._vel * dt;
    this.x = px + this._dir.x * step;
    this.y = py + (this._dir.y ?? 0) * step;
    this.z = pz + this._dir.z * step;
    this._dist += step;

    // The trail, while asked for.
    if (this.drawPaths === true || this.drawPaths === 'true') {
      this._trail.push(this.x, this.y, this.z);
      if (this._trail.length > 240) this._trail.splice(0, 3); // last ~80 points
      this.setComponent('debug', 'path', [...this._trail]);
    }

    // First body whose volume the FLIGHT SEGMENT crosses takes the damage.
    // SUB-STEPPED: an accelerating round covers 0.25–0.6 m a frame, and a
    // point-per-frame test sailed clean through a 10 cm whiteboard (thin
    // targets tunnel). Sample the segment every ~12 cm — AABB checks are
    // cheap, targets are few.
    const targets = [];
    for (const e of this.world?.scene?.all() ?? []) {
      if (e === this || e === this._shooter || typeof e.takeDamage !== 'function') continue;
      if (e.visible === false || e._dead) continue;
      targets.push(e);
    }
    if (targets.length) {
      // SPAWN GRACE (§18.38): the muzzle can sit against (or inside) a mesh —
      // firing point-blank at a tree birthed the round inside a volume and it
      // died on its first sub-step, which read as "the bazooka didn't fire".
      // Hits inside the first `(spawnGrace)` metres of flight don't count; a
      // large point-blank target is still well inside its volume when the
      // round clears the grace, so real close shots still land.
      const grace = Math.max(0, Number(this.spawnGrace ?? 0.6));
      const flownAtStart = this._dist - step;
      const samples = Math.max(1, Math.ceil(step / 0.12));
      for (let s = 1; s <= samples; s++) {
        const t = s / samples;
        if (flownAtStart + step * t < grace) continue;
        const sx = px + this._dir.x * step * t;
        const sy = py + (this._dir.y ?? 0) * step * t;
        const sz = pz + this._dir.z * step * t;
        for (const e of targets) {
          if (e.containsPoint?.(sx, sy, sz, 0.2)) {
            const wasDead = !!e._dead;
            e.takeDamage(Number(this.damage) || 0, this._shooter ?? this);
            // A round that KILLS earns the same finisher emphasis as a
            // melee blow (§18.41) — no hit stop on ordinary hits though;
            // freezing the world for every bazooka splash felt spammy.
            if (!wasDead && e._dead) {
              this.world?.loop?.slowMo?.(0.7, 0.12, 0.45);
              this.world?.input3d?.rumble?.(1.0, 0.6, 320);
            }
            this.world?.loop?.dispatchTo?.(this, 'onHit', e); // the round hears its impact
            return this._expire();
          }
        }
      }
    }

    if (this._dist >= (Number(this.range) || 30)) this._expire();
  }

  /** End of the road: a fired round removes itself; the template just hides. */
  _expire() {
    this._flying = false;
    this.setComponent('debug', 'path', null);
    if (this._spawned) this.world?.scene?.remove?.(this.id);
    else this.visible = false;
  }
}

AE1Projectile.agsDef = {
  name: 'Projectile',
  extends: null,
  runInfo: { _projBegin: ['onLoad'], _projTick: ['onTick'] },
};

AE1Projectile.agsDat = {
  ...AE1Hitbox.agsDat,
  pickable: false, // ammunition is fired, not pocketed
  hasPhysics: false, // its own flight math, not the item gravity
  speed: 14,
  acceleration: 0,
  range: 30,
  damage: 50,
  drawPaths: false,
  faceOffset: 0,
  // Hits inside this many metres of flight don't count (§18.38) — a muzzle
  // pressed against a mesh must not kill the round at birth.
  spawnGrace: 0.6,
};

defineDatAccessors(AE1Projectile);
