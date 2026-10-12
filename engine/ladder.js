/**
 * AE1 - Ladder: a climbable ladder element (the reference action game-style).
 *
 * `(extends Ladder)` on a model whose glb carries INDEXED RUNG SOCKETS —
 * empty child nodes named rung_00, rung_01, … rung_NN with the index
 * increasing rung by rung up the ladder (meshforge's `sockets` block emits
 * exactly this convention). Once the renderer binds the object, the class
 * reads the sockets and publishes climb geometry for the character:
 *
 *   ladderInfo() -> {
 *     x, z          — the center line (world)
 *     yBottom, yTop — first and last rung heights (world)
 *     pitch         — rung spacing (m)
 *     rungYs        — every rung height, ascending (world)
 *     faceYaw       — the yaw a climber faces while on the ladder
 *     normal        — {x, z} unit, pointing OUT of the climb face
 *   }
 *
 * The climb face is the −Z side of the glb by convention (a climber walks
 * toward +Z... i.e. faces the ladder looking −Z→ladder local +Z? No—): the
 * meshforge ladder's rungs span local X with the approach on local −Z is
 * arbitrary; `faceNormal` dat picks the side (+1 = approach from local +Z,
 * the default; −1 = from local −Z). The character mounts from either side
 * in the reference action game fashion but aligns to the face this picks.
 *
 * the reference action game mount doctrine (researched): attaching is proximity-based — no
 * button. The character walks into the ladder and the CHARACTER class does
 * the grabbing; this element only advertises geometry. Rung sockets double
 * as future hand/foot IK anchors.
 *
 * dat:
 *   (climbOffset 0.32)  ; metres out from the rung plane the body rides
 *   (faceNormal 1)      ; +1: approach from local +Z (default), -1: local -Z
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Model } from './model3d.js';

const DEG = Math.PI / 180;

export class AE1Ladder extends AE1Model {
  /** climb geometry, computed lazily from the bound object's rung sockets */
  _ladderInfo = null;

  isLadder = true;

  _ladderScan() {
    const obj = this.world?.env3d?.objectFor?.(this);
    if (!obj) return null;
    const rungs = [];
    obj.traverse((o) => {
      const m = /^rung_(\d+)$/.exec(o.name);
      if (m) rungs.push([parseInt(m[1], 10), o]);
    });
    if (!rungs.length) return null;
    rungs.sort((a, b) => a[0] - b[0]);
    obj.updateWorldMatrix(true, false);
    const ys = [];
    let cx = 0;
    let cz = 0;
    for (const [, o] of rungs) {
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      ys.push(e[13]);
      cx += e[12];
      cz += e[14];
    }
    cx /= rungs.length;
    cz /= rungs.length;
    const side = (Number(this.faceNormal) || 1) >= 0 ? 1 : -1;
    const yawEl = (Number(this.rotationY) || 0) * DEG;
    // local +Z rotated by the element's yaw, flipped by faceNormal — the
    // direction OUT of the climb face, toward the approaching character.
    const nx = Math.sin(yawEl) * side;
    const nz = Math.cos(yawEl) * side;
    const pitch = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 0.28;
    this._ladderInfo = {
      x: cx,
      z: cz,
      yBottom: ys[0],
      yTop: ys[ys.length - 1],
      pitch,
      rungYs: ys,
      // the climber faces INTO the ladder: opposite of the outward normal
      faceYaw: Math.atan2(-nx, -nz),
      normal: { x: nx, z: nz },
    };
    return this._ladderInfo;
  }

  /** Climb geometry (world). null until the renderer has bound the glb. */
  ladderInfo() {
    return this._ladderInfo || this._ladderScan();
  }

  /** Nearest rung index for a world height (clamped). */
  rungAt(y) {
    const li = this.ladderInfo();
    if (!li) return 0;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < li.rungYs.length; i++) {
      const d = Math.abs(li.rungYs[i] - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}

AE1Ladder.agsDef = {
  name: 'Ladder',
  extends: null,
  // Model's own hooks are inherited via the prototype; hand-built agsDefs
  // do not merge runInfo up the chain (the ThirdPersonCharacter lesson), so
  // _modelBegin must be re-declared here or the mesh never appears.
  runInfo: { _modelBegin: ['onLoad'] },
};

AE1Ladder.agsDat = {
  ...AE1Model.agsDat,
  climbOffset: 0.32,
  faceNormal: 1,
};

defineDatAccessors(AE1Ladder);
