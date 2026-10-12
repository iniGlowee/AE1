/**
 * AE1 - Scatter: ONE element, MANY placements (DESIGN.md §18.23).
 *
 * `(extends Scatter)` on a mesh element makes it an ARCHETYPE: the element
 * itself renders where it stands, and `(spawns …)` places render-COPIES of
 * it across the scene — trees, pots, lamp posts, every static detail that
 * repeats. The copies are renderer clones sharing the archetype's geometry
 * and materials: one mesh in memory, a list of coordinates in dat, instead
 * of N imported duplicates.
 *
 *   (spawns (
 *     (x y z)              ; a copy at x,y,z
 *     (x y z yaw)          ; …turned yaw degrees about up
 *     (x y z yaw scale)))  ; …scaled on top of the archetype's own scale
 *   (spawnSnap true)       ; drop each copy to the ground under its x,z
 *                          ; (trees on a rolling hill need no hand-tuned y)
 *
 * Copies are STATIC DRESSING, deliberately: no elements are created for
 * them, so they have no scripts, no hitboxes, and no collision — a copy is
 * a picture of the archetype, not a clone of its behaviour.
 *
 * §18.93: copies now render as GPU INSTANCES — one InstancedMesh per
 * non-skinned archetype mesh, so a thousand trees is a handful of draw
 * calls, not a thousand clones. A skinned archetype falls back to clones
 * (InstancedMesh has no per-instance skeleton). The dat surface is unchanged.
 *
 * The renderer (`applyScatter`) reads the list live — edit the numbers in
 * Properties and copies move, in the EDITOR VIEWPORT too: scatter is level
 * dressing, and dressing you cannot see while arranging is useless.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Scatter extends AE1Element {
  /** The spawn list, normalised to [x, y, z, yawDeg, scale] rows — the
   *  reader collapses a single entry to a bare tuple (the animations trap). */
  spawnList() {
    let v = this.spawns;
    if (!Array.isArray(v)) return [];
    if (v.length && typeof v[0] !== 'object') v = [v]; // single-entry collapse
    return v
      .filter((e) => Array.isArray(e) && e.length >= 2)
      .map((e) => [
        Number(e[0]) || 0,
        Number(e[1]) || 0,
        Number(e[2]) || 0,
        Number(e[3]) || 0,
        e[4] == null ? 1 : Number(e[4]) || 1,
      ]);
  }
}

AE1Scatter.agsDef = {
  name: 'Scatter',
  extends: null,
  runInfo: {},
};

AE1Scatter.agsDat = {
  spawns: [],
  spawnSnap: false,
};

defineDatAccessors(AE1Scatter);
