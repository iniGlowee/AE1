/**
 * AE1 - Light (§18.48): the first-class light element. Until now, light
 * came only from glb-embedded light nodes (render3d's applyLight tweaks a
 * BOUND light) or the environment map — there was no way to just SAY "a sun
 * hangs here." Now `(extends Light)` (or the builtin directly) is a real
 * scene element the renderer manages as its own object:
 *
 *   (lightType "sun")     directional — the outdoor key light. Aims from
 *                         its position toward a slightly-tilted point below
 *                         (dead-vertical light reads flat).
 *   (lightType "point")   a lamp: (distance) range, inverse-square falloff.
 *   (lightType "spot")    a cone: (angle)(penumbra)(distance).
 *
 * `(fill 0.35)` adds a hemisphere fill (sky/ground bounce) riding the same
 * element — one element lights a whole testbed. `(follow true)` glues it
 * above the player (`(height)` up), so the character is always lit — the
 * "sun above the character" ask.
 *
 * Deliberately thin: the element owns POSITION and dat state; the renderer
 * owns the THREE objects (lightSets in render3d). That seam is where
 * shadows, light probes, and whatever a future GPU build wants will plug
 * in — the generalization hook, not the feature (§ ROADMAP).
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Light extends AE1Element {
  _lightTick(_dt) {
    if (!(this.follow === true || this.follow === 'true')) return;
    const p = this.world?.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (!p) return;
    this.x = p.x ?? 0;
    this.z = p.z ?? 0;
    // lightHeight, NOT height — that is a base schema field (invariant 17,
    // and yes, this line originally shadowed it and hovered at 0.5 m)
    this.y = (p.y ?? 0) + (Number(this.lightHeight) || 12);
  }
}

AE1Light.agsDef = {
  name: 'Light',
  extends: null,
  runInfo: { _lightTick: ['onTick'] },
};

AE1Light.agsDat = {
  lightType: 'sun', // 'sun' | 'point' | 'spot'
  color: '#ffffff',
  intensity: 2.2,
  // point/spot range (0 = infinite for point); spot cone
  distance: 0,
  angle: 40, // degrees, spot half-angle
  penumbra: 0.4,
  // hemisphere fill riding along (0 = none): sky color over ground bounce
  fill: 0.3,
  // the sun-above-the-character mode (lightHeight: metres above the player)
  follow: false,
  lightHeight: 12,
};

defineDatAccessors(AE1Light);
