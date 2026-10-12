/**
 * AE1 - CharacterCameraCurve + CharacterCameraCourse (§18.49): scripted
 * camera cinematics ON the third-person camera — the fishing-presentation
 * sweep, and every future cutscene move.
 *
 * A CURVE is an automated camera track RELATIVE TO THE CHARACTER: its
 * `(curvePoints ((t px py pz lx ly lz) ...))` rows are offsets in the
 * character's frame — position and look-at, rotated by the character's
 * heading and anchored at their feet AT PLAY TIME — so the same sweep works
 * wherever, whichever way, the character stands. `play()` claims the
 * camera; the ThirdPersonCamera hands over its fields while a curve is
 * live and takes the orbit back the moment it ends. Script hooks: `onStart`
 * fires as the claim lands, `onEnd` as it releases (finish or stop()).
 *
 * THE RULE, engine-enforced: two curves can NEVER be active at once —
 * `play()` on a second curve refuses (returns false, warns) while another
 * holds the camera. One camera, one author at a time.
 *
 * A COURSE strings curves together: `(courseCurves ("SweepIn" "HoldFish"))`
 * — names resolved through the global element lookup (any script anywhere:
 * `this.find("PresentationCourse").playCourse()`), advancing as each curve
 * ends, modifiable on the fly (`setCurves([...])`), stoppable
 * (`stopCourse()`). The course never touches the camera itself; it only
 * conducts curves — the one-active rule stays intact by construction.
 */

import { AE1Element, defineDatAccessors } from './element.js';

const CC_DEG = Math.PI / 180;

function rows(v) {
  // (curvePoints ((...)(...))) — the reader may collapse single rows
  if (!Array.isArray(v)) return [];
  if (v.length && !Array.isArray(v[0])) return [v];
  return v;
}

export class AE1CharacterCameraCurve extends AE1Element {
  _ccPlaying = false;
  _ccT = 0;
  _ccSample = null;

  /** Claim the camera and run the track. False (with a warning) if another
   *  curve is live — the one-active rule. */
  play() {
    const w = this.world;
    if (!w) return false;
    if (w._camCurveActive && w._camCurveActive !== this) {
      console.warn(`[CameraCurve] "${this.name}" refused: "${w._camCurveActive.name}" is active`);
      return false;
    }
    const chr = w.scene?.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    const pts = rows(this.curvePoints).map((r) => r.map(Number));
    if (!chr || pts.length < 2) {
      console.warn(`[CameraCurve] "${this.name}" needs a character and 2+ curvePoints`);
      return false;
    }
    // anchor: the character's feet + heading AT PLAY TIME
    const yaw = ((chr._heading ?? chr.rotationY ?? 0) + (Number(this.anchorYawOffset) || 0)) * CC_DEG;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const ax = chr.x ?? 0;
    const ay = chr.y ?? 0;
    const az = chr.z ?? 0;
    this._ccKeys = pts.map(([t, px, py, pz, lx, ly, lz]) => ({
      t,
      x: ax + px * cos + pz * sin,
      y: ay + py,
      z: az - px * sin + pz * cos,
      lx: ax + lx * cos + lz * sin,
      ly: ay + ly,
      lz: az - lx * sin + lz * cos,
    }));
    this._ccT = 0;
    this._ccPlaying = true;
    w._camCurveActive = this;
    this._ccStep(0); // first sample this frame — no one-frame orbit flash
    w.loop?.dispatchTo(this, 'onStart');
    return true;
  }

  /** Release the camera early (or naturally at the end). */
  stop() {
    if (!this._ccPlaying) return;
    this._ccPlaying = false;
    this._ccSample = null;
    if (this.world?._camCurveActive === this) this.world._camCurveActive = null;
    this.world?.loop?.dispatchTo(this, 'onEnd');
  }

  get playing() {
    return this._ccPlaying;
  }

  _ccTick(dt) {
    if (!this._ccPlaying) return;
    this._ccStep(dt * (Number(this.playRate) || 1));
  }

  _ccStep(dt) {
    const keys = this._ccKeys;
    this._ccT += dt;
    const end = keys[keys.length - 1].t;
    const t = Math.min(this._ccT, end);
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const span = Math.max(1e-4, b.t - a.t);
    let u = Math.max(0, Math.min(1, (t - a.t) / span));
    u = u * u * (3 - 2 * u); // smoothstep per segment — eased, never robotic
    this._ccSample = {
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      z: a.z + (b.z - a.z) * u,
      lx: a.lx + (b.lx - a.lx) * u,
      ly: a.ly + (b.ly - a.ly) * u,
      lz: a.lz + (b.lz - a.lz) * u,
    };
    if (this._ccT >= end) {
      if (this.holdAtEnd === true || this.holdAtEnd === 'true') return; // a course advances us
      this.stop();
    }
  }
}

AE1CharacterCameraCurve.agsDef = {
  name: 'CharacterCameraCurve',
  extends: null,
  runInfo: { _ccTick: ['onTick'] },
};

AE1CharacterCameraCurve.agsDat = {
  // rows of (t  posX posY posZ  lookX lookY lookZ), CHARACTER-relative:
  // +z is ahead of the character, +x their right, y above their feet.
  curvePoints: [],
  playRate: 1,
  // true: freeze on the last frame instead of releasing (a course, or a
  // script that wants to hold the shot, ends it explicitly)
  holdAtEnd: false,
  // rotate the whole track around the character (deg) without re-authoring
  anchorYawOffset: 0,
};

defineDatAccessors(AE1CharacterCameraCurve);

export class AE1CharacterCameraCourse extends AE1Element {
  _coIdx = -1;
  _coRunning = false;

  _coList() {
    const v = this._coOverride ?? this.courseCurves;
    const list = typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) ? v.map(String) : [];
    return list;
  }

  /** Conduct the curve list from the top. */
  playCourse() {
    const list = this._coList();
    if (!list.length) return false;
    this._coIdx = -1;
    this._coRunning = true;
    return this._coNext();
  }

  stopCourse() {
    if (!this._coRunning) return;
    this._coRunning = false;
    const cur = this._coCurrent();
    cur?.stop?.();
    this._coIdx = -1;
    this.world?.loop?.dispatchTo(this, 'onEnd');
  }

  /** Replace the running order on the fly — takes effect from the NEXT
   *  advance (the current curve finishes honestly). */
  setCurves(names) {
    this._coOverride = Array.isArray(names) ? names.map(String) : null;
  }

  /** Jump to the next curve immediately (skip button material). */
  skip() {
    if (this._coRunning) this._coNext();
  }

  get running() {
    return this._coRunning;
  }

  _coCurrent() {
    const list = this._coList();
    const name = list[this._coIdx];
    return name ? this.find(String(name)) : null;
  }

  _coNext() {
    this._coCurrent()?.stop?.();
    this._coIdx += 1;
    const list = this._coList();
    if (this._coIdx >= list.length) {
      this._coRunning = false;
      this._coIdx = -1;
      this.world?.loop?.dispatchTo(this, 'onEnd');
      return true;
    }
    const curve = this.find(String(list[this._coIdx]));
    if (!curve || typeof curve.play !== 'function') {
      console.warn(`[CameraCourse] "${this.name}": no curve named "${list[this._coIdx]}"`);
      this._coRunning = false;
      return false;
    }
    if (this._coIdx === 0) this.world?.loop?.dispatchTo(this, 'onStart');
    return curve.play();
  }

  _coTick(_dt) {
    if (!this._coRunning) return;
    const cur = this._coCurrent();
    // advance when the current curve released OR sits held on its last frame
    if (!cur || !cur.playing || (cur._ccPlaying && cur._ccT >= (cur._ccKeys?.at(-1)?.t ?? 0)
      && (cur.holdAtEnd === true || cur.holdAtEnd === 'true') && this._coIdx < this._coList().length - 1)) {
      this._coNext();
    }
  }
}

AE1CharacterCameraCourse.agsDef = {
  name: 'CharacterCameraCourse',
  extends: null,
  runInfo: { _coTick: ['onTick'] },
};

AE1CharacterCameraCourse.agsDat = {
  courseCurves: [], // curve ELEMENT NAMES, in playing order
};

defineDatAccessors(AE1CharacterCameraCourse);
