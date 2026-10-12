/**
 * AE1 - LockMarker (§18.43): the lock-on indicator — a small white circle
 * billboarded in front of the locked enemy, Dark Souls style.
 *
 * SPAWNED, never authored: the character creates one on lock and removes it
 * on release (`_lockAcquire` / `_lockRelease` in thirdperson.js) — scenes
 * carry no marker element and need none. The renderer picks the spawn up on
 * its own (game3d rebuilds when the element count changes).
 *
 * A BASE CLASS on purpose: today it is a flat white disc; the plan is
 * alchemy-circle rings — spinning, recoloring, layered. That future lives in
 * the dats (`ringSpin` already turns; a script may `(extends LockMarker)`
 * and override media, size, spin, color when the fancy art exists). The
 * positioning/billboarding machinery is the part worth inheriting.
 *
 * Placement: at the target's render-bounds center, pulled `ringToward`
 * metres toward the camera so it floats IN FRONT of the enemy (§ Austin's
 * spec), facing the camera. Roll (`rotation`) spins in the billboard plane —
 * invisible on a disc, alive on any future ring texture.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1LockMarker extends AE1Element {
  _lockMarkTick(dt) {
    const scn = this.world?.scene;
    if (!scn) return;
    const player = scn.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    const t = player?._lockTarget;
    if (!t || t._dead || t.visible === false) {
      this.visible = false; // released this frame; the character removes us next
      return;
    }
    const b = this.world?.env3d?.boundsOf?.(t);
    const cx = b ? (b.min.x + b.max.x) / 2 : (t.x ?? 0);
    const cy = b ? (b.min.y + b.max.y) / 2 : (t.y ?? 0) + 1;
    const cz = b ? (b.min.z + b.max.z) / 2 : (t.z ?? 0);
    const cam = scn.all().find((e) => typeof e._camTick === 'function');
    let px = cx;
    let py = cy;
    let pz = cz;
    if (cam) {
      const dx = (cam.x ?? 0) - cx;
      const dy = (cam.y ?? 0) - cy;
      const dz = (cam.z ?? 0) - cz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const toward = Number(this.ringToward) || 0.55;
      px += (dx / len) * toward;
      py += (dy / len) * toward;
      pz += (dz / len) * toward;
    }
    this.visible = true;
    this.x = px;
    this.y = py;
    this.z = pz;
    // BILLBOARD: the disc is forged cap-up (+Y); +90° about X turns the cap
    // to +Z, and copying the camera's yaw/pitch then points that +Z straight
    // back at the lens. Roll spins inside the billboard plane.
    this.rotationY = cam?.rotationY ?? 0;
    this.rotationX = (cam?.rotationX ?? 0) + 90;
    const spin = Number(this.ringSpin) || 0;
    if (spin) this.rotation = ((this.rotation ?? 0) + spin * dt) % 360;
    const s = Number(this.ringSize) || 1;
    this.scaleX = s;
    this.scaleY = s;
    this.scaleZ = s;
  }
}

AE1LockMarker.agsDef = {
  name: 'LockMarker',
  extends: null,
  runInfo: { _lockMarkTick: ['onTick'] },
};

AE1LockMarker.agsDat = {
  ringSize: 1, // scale multiplier over the forged disc (0.16 m radius)
  ringSpin: 60, // deg/s roll — invisible on the plain disc, alive on rings
  ringToward: 0.55, // metres pulled toward the camera: IN FRONT of the enemy
};

defineDatAccessors(AE1LockMarker);
