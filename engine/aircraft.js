/**
 * AE1 - Aircraft (DESIGN.md §18.52): a PILOTABLE VEHICLE base element — the
 * the reference action game flight unit today; planes, helicopters, anything ridden tomorrow.
 *
 * THE CONTRACT (Austin's spec): the THIRD-PERSON CHARACTER stays the root of
 * truth — input, position, hitbox all live on her. Boarding puts her driver
 * in ladder mode (physics suspended, vertical honored) and hands her root to
 * THIS element's flight physics; the aircraft MIRRORS her — its rendered
 * body rides at (pilot - seat offsets) every tick. Visually she "becomes"
 * the aircraft; mechanically the aircraft is a costume around her root.
 *
 * TWO PILOTED MODES, per the flight unit's own canon:
 *
 *  TRAVEL ("Asura", upright mobile config) — Armored Core-flavored hover:
 *    camera-relative strafe with inertia, boost held / QUICK-BOOST tapped,
 *    terrain-following hover that can descend slowly but never climbs on
 *    input, melee + shot attacks. The fox orbit camera stays — she IS the
 *    craft, so the ordinary third-person camera just works.
 *
 *  FLIGHT ("Cygnus", jet config) — Ace Combat-flavored: throttle, pitch,
 *    roll-to-turn, real altitude. A chase camera (banked with the craft,
 *    FOV scaling with speed) is requested through `pilot._flightCam`,
 *    consumed by AE1ThirdPersonCamera.
 *
 * MODE RULES: F transforms travel -> flight anywhere; flight -> travel only
 * within `travelEnterHeight` of the ground. E boards (via a trigger's
 * `craft.board(actor)`) and dismounts — travel mode only. Every transition
 * plays the SYNCED PAIR (the unit's clip + the pilot's own retargeted mot)
 * and can conduct a CharacterCameraCurve/Course by name (dat-configured).
 *
 * The pilot HIDES during clips that would clip through the transforming
 * hull (`hidePilotInFlight`, attacks) and re-appears riding her authored
 * pose — enriched wherever the library shipped a pair.
 *
 * Subclass with `(extends Aircraft)`: every clip name, speed, and rule is a
 * dat; onBoard / onUnboard / onModeChange dispatch for AGS enrichment.
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Controller, turnToward } from './thirdperson.js';
import { AE1AoeWave } from './enemyattacks.js';

const AC_DEG = Math.PI / 180;

export class AE1Aircraft extends AE1Element {
  _acMode = 'parked'; // parked|boarding|travel|toFlight|flight|toTravel|unboarding
  _acPilot = null;
  _acVel = { x: 0, z: 0 };
  _acSpeed = 0; // flight-mode airspeed along the nose
  _acPitch = 0; // deg, + = nose up
  _acBank = 0; // deg, + = right wing down
  _acHeading = 0;
  _acClip = '';
  _acActT = 0; // one-shot (attack/QB) lockout timer
  _acBoostT = -1; // boost-key press timestamp for the tap=QB / hold=boost split
  _acHidden = false;
  _acCamSet = true; // orbit parked behind the craft yet (armed on travel entry)
  _acCutT = 0; // cut-board reveal countdown (empty pilotBoard)

  get mode() { return this._acMode; }

  get piloted() { return !!this._acPilot; }

  /* -- helpers ------------------------------------------------------------- */

  _acPlay(name, { loop = true, fade = 0.15 } = {}) {
    if (!name || this._acClip === name) return;
    this._acClip = String(name);
    this.playAnimation(this._acClip, { loop, fade });
  }

  _acPilotAction(name, opts = {}) {
    const mm = this._acPilot?._mm;
    if (!mm || !name) return false;
    // hold: input must never recovery-cancel a synced pair (§18.51)
    return mm.playAction(String(name), { hold: true, ...opts });
  }

  _acHidePilot(hide) {
    const p = this._acPilot;
    if (!p || this._acHidden === !!hide) return;
    this._acHidden = !!hide;
    p.visible = !hide;
  }

  _acGround(x, z, fromY) {
    // world-space raycast — ALWAYS pass fromY (§18.52: an omitted origin was
    // a night of phantom "frame-dependent" readings)
    return this.world?.env3d?.groundAt?.(this._acPilot ?? this, x, z, fromY) ?? null;
  }

  _acCam() {
    return this.world?.scene?.all().find((e) => typeof e._camTick === 'function');
  }

  _acCourse(name) {
    if (!name) return;
    const el = this.find(String(name));
    if (el?.playCourse) el.playCourse();
    else el?.play?.();
  }

  /** Fire a named Particles element's burst (§18.52) — every combat and
   *  transition seam calls one; empty dat = no effect, nothing breaks. */
  _acFx(name) {
    if (!name) return;
    this.find(String(name))?.burst?.();
  }

  /** The looping thruster effect only breathes while the craft is piloted. */
  _acThruster(on) {
    const name = String(this.thrusterFx || '');
    if (!name) return;
    const el = this.find(name);
    if (el && el.visible !== !!on) el.visible = !!on;
  }

  _acDispatch(evt, arg) {
    this.world?.loop?.dispatchTo(this, evt, arg);
  }

  /** PHASE LOCK (§18.52): the pilot's action age is the master clock — the
   *  hull's mixer is slaved to it every tick, so the synced pair can never
   *  drift apart (tab suspends, clock clamps, nothing). The authored pairs
   *  share exact frame counts, so equal time IS equal pose. */
  _acSync(mm) {
    if (!mm?.inAction) return;
    const age = mm.actionAge;
    if (Number.isFinite(age)) this.world?.env3d?.setClipTime?.(this, age);
  }

  /** Park the ORBIT camera behind the craft's nose — entering travel must
   *  honor the unit's heading, never the approach camera's (Austin's rule:
   *  the camera adopts the craft, the craft never turns for the camera).
   *  The orbit also backs off to `travelCamDist`: the human-scale 3.5 m
   *  default sits INSIDE a ten-meter hull. Restored at dismount. */
  _acCamBehind() {
    const cam = this._acCam();
    if (!cam) return;
    cam._yaw = ((this._acHeading + 180) % 360 + 360) % 360;
    cam._pitch = 8;
    if (this._acCamDist === undefined) this._acCamDist = cam.distance;
    cam.distance = Number(this.travelCamDist) || 8;
  }

  _acCamRestore() {
    const cam = this._acCam();
    if (cam && this._acCamDist !== undefined) {
      cam.distance = this._acCamDist;
      this._acCamDist = undefined;
    }
  }

  _acSetMode(m) {
    if (this._acMode === m) return;
    this._acMode = m;
    this._acDispatch('onModeChange', m);
  }

  /* -- boarding / dismount ------------------------------------------------- */

  /** A trigger's E calls this. Snaps the pilot to the mount anchor, plays
   *  the synced Board pair, conducts the board camera course. */
  board(actor) {
    if (this._acMode !== 'parked' || !actor?._mm) return false;
    const mm = actor._mm;
    if (!mm.grounded) return false;
    this._acPilot = actor;
    actor._pilotCraft = this;
    const h = (this.rotationY ?? 0) * AC_DEG;
    const fwd = Number(this.boardForward) || 0;
    mm.teleport((this.x ?? 0) + Math.sin(h) * fwd, (this.z ?? 0) + Math.cos(h) * fwd, null);
    mm.setYaw(((this.rotationY ?? 0) + 180) * AC_DEG); // facing the hull
    mm.setLadderMode(true); // the climb's vertical root motion is honored
    // THE CUT BOARD (Austin's call): with no honest climb animation in the
    // library (her a020 is an in-place mount authored AT cockpit height —
    // ground-level it reads as a tilted flag-board; a005 is the acrobatic
    // flip), an EMPTY pilotBoard hides her and seats her directly after
    // `boardCutTime` — the seam a particle burst or a custom-authored
    // climb fills in later.
    if (!String(this.pilotBoard || '')) {
      this._acHidePilot(true);
      this._acCutT = Number(this.boardCutTime) || 0.6;
      this._acSetMode('boarding');
      this._acCourse(this.boardCourse);
      this._acDispatch('onBoard', actor);
      return true;
    }
    this._acPilotAction(this.pilotBoard);
    // an EMPTY clipBoard means the unit has no receiving animation — it
    // keeps its idle loop while the pilot climbs (the calm mount: the player character's
    // a020 has no true unit half; unit a020 is a knockback that shares
    // the number — the ID pairing does not hold everywhere, §18.52)
    if (String(this.clipBoard || '')) {
      this._acPlay(String(this.clipBoard), { loop: false, fade: 0.1 });
    }
    this._acSetMode('boarding');
    this._acCourse(this.boardCourse);
    this._acDispatch('onBoard', actor);
    return true;
  }

  /** E in travel mode. Plays the synced Unboard pair; control returns to the
   *  third-person character when it completes. */
  unboard() {
    if (this._acMode !== 'travel' || !this._acPilot) return false;
    // THE CUT EXIT (same doctrine as the cut board): empty pilotExit hides
    // her and sets her down beside the unit after the beat — her a023 is
    // authored at cockpit height too and read as the same tilted board.
    if (!String(this.pilotExit || '')) {
      this._acHidePilot(true);
      this._acCutT = Number(this.boardCutTime) || 0.6;
      this._acSetMode('unboarding');
      this._acCourse(this.exitCourse);
      return true;
    }
    this._acHidePilot(false);
    this._acPilotAction(this.pilotExit);
    if (String(this.clipUnboard || '')) {
      this._acPlay(String(this.clipUnboard), { loop: false, fade: 0.1 });
    }
    this._acSetMode('unboarding');
    this._acCourse(this.exitCourse);
    return true;
  }

  /* -- the seat: pilot root <-> aircraft body ------------------------------ */

  _acFinishUnboard(p, mm) {
    this._acHidePilot(false); // needs _acPilot still set — first, always
    this._acFx(this.seamFx); // the dismount flash covers the reveal
    this._acThruster(false);
    mm.setLadderMode(false); // gravity resumes; feet find the ground
    p._pilotCraft = null;
    this._acPilot = null;
    this._acHidden = false;
    this.world?.env3d?.setLodFar?.(false); // never leave the map decimated on foot
    this._acSetMode('parked');
    this._acPlay(String(this.clipIdle), { loop: true });
    this._acCamRestore(); // human-scale orbit distance again
    this._acDispatch('onUnboard', p);
    console.log('[Aircraft] powered down.');
  }

  _acEnterTravel() {
    this._acSetMode('travel');
    this._acSeatPilot();
    this._acPilotAction(this.pilotRide);
    this._acPlay(String(this.clipTravelIdle), { loop: true });
    this._acVel = { x: 0, z: 0 };
    this._acCamSet = false; // park the orbit behind once the curve releases
    this._acFx(this.seamFx); // the boarding flash covers the reveal
    this._acThruster(true);
    console.log('[Aircraft] travel mode — systems live.');
  }

  _acSeatPilot() {
    // called once entering travel: park the pilot's root AT the seat
    const mm = this._acPilot?._mm;
    if (!mm) return;
    const uh = (this.rotationY ?? 0) * AC_DEG;
    const fwd = Number(this.seatForward) || 0;
    mm.teleport(
      (this.x ?? 0) + Math.sin(uh) * fwd,
      (this.z ?? 0) + Math.cos(uh) * fwd,
      (this.y ?? 0) + (Number(this.seatHeight) || 0));
    mm.setYaw(((this.rotationY ?? 0) + (Number(this.seatYaw) || 0)) * AC_DEG);
    this._acHeading = (this.rotationY ?? 0) + (Number(this.seatYaw) || 0);
  }

  _acMirror() {
    // every piloted tick: the aircraft body rides at (pilot - seat offsets)
    const p = this._acPilot;
    if (!p) return;
    this.rotationOrder = 'YXZ'; // yaw -> pitch -> bank, aircraft semantics
    const h = (this._acHeading - (Number(this.seatYaw) || 0)) * AC_DEG;
    const fwd = Number(this.seatForward) || 0;
    this.x = (p.x ?? 0) - Math.sin(h) * fwd;
    this.z = (p.z ?? 0) - Math.cos(h) * fwd;
    this.y = (p.y ?? 0) - (Number(this.seatHeight) || 0);
    this.rotationY = this._acHeading - (Number(this.seatYaw) || 0);
    this.rotationX = -this._acPitch;
    this.rotation = -this._acBank;
  }

  /* -- per-mode ticks ------------------------------------------------------ */

  _acTick(dt) {
    const mode = this._acMode;
    if (mode === 'parked') return;
    const p = this._acPilot;
    const mm = p?._mm;
    if (!mm) { this._acAbort(); return; }
    const input = this.world?.input3d;
    const ctl = AE1Controller.mappingsIn(this.world);

    if (mode === 'boarding') {
      // the cut board: she is hidden — count the beat, then seat + reveal
      if (!String(this.pilotBoard || '')) {
        this._acCutT -= dt;
        if (this._acCutT <= 0) {
          this._acEnterTravel();
          this._acHidePilot(false);
        }
        return;
      }
      if (String(this.clipBoard || '')) this._acSync(mm); // paired halves only
      if (!mm.inAction) this._acEnterTravel();
      return;
    }

    if (mode === 'unboarding') {
      // the cut exit: hidden — count the beat, set her down at the mount
      // spot (ground-snapped), reveal her standing
      if (!String(this.pilotExit || '')) {
        this._acCutT -= dt;
        if (this._acCutT > 0) return;
        const h = (this.rotationY ?? 0) * AC_DEG;
        const fwd = Number(this.boardForward) || 0;
        const ax = (this.x ?? 0) + Math.sin(h) * fwd;
        const az = (this.z ?? 0) + Math.cos(h) * fwd;
        mm.stopAction?.(); // release the held ride pose
        // she reappears at SEAT height — but never below `exitDropHeight`
        // above the anchor's OWN ground: on angled terrain the ground at
        // the reveal spot can sit as high as the seat and the clamp ate
        // the drop (Austin's elevated-terrain report). The little fall +
        // landing animation is guaranteed everywhere now.
        const eg = this._acGround(ax, az, (p.y ?? 0) + 6);
        let ey = p.y ?? 0;
        if (Number.isFinite(eg)) {
          ey = Math.max(ey, eg + (Number(this.exitDropHeight) || 1.4));
        }
        mm.teleport(ax, az, ey);
        this._acFinishUnboard(p, mm);
        return;
      }
      if (String(this.clipUnboard || '')) this._acSync(mm);
      if (!mm.inAction) this._acFinishUnboard(p, mm);
      return;
    }

    if (mode === 'toFlight' || mode === 'toTravel') {
      this._acSync(mm);
      this._acActT -= dt;
      // level out through the fold
      this._acPitch = turnToward(this._acPitch, 0, 90 * dt);
      this._acBank = turnToward(this._acBank, 0, 120 * dt);
      this._acTransitionMove(dt);
      if (this._acActT <= 0) {
        if (mode === 'toFlight') {
          this._acSetMode('flight');
          this._acSpeed = Math.max(Number(this.flightMin) || 14,
            Math.hypot(this._acVel.x, this._acVel.z) + 8);
          if (this.hidePilotInFlight !== false && this.hidePilotInFlight !== 'false') {
            this._acHidePilot(true);
          } else this._acPilotAction(this.pilotProne);
          this._acPlay(String(this.clipCruise), { loop: true });
          console.log('[Aircraft] flight mode — Cygnus configuration.');
        } else {
          this._acSetMode('travel');
          this._acHidePilot(false);
          this._acPilotAction(this.pilotRide);
          const h = this._acHeading * AC_DEG;
          const sp = Math.min(Number(this.travelSpeed) || 12, this._acSpeed);
          this._acVel = { x: Math.sin(h) * sp, z: Math.cos(h) * sp };
          this._acPlay(String(this.clipTravelIdle), { loop: true });
          console.log('[Aircraft] travel mode — Asura configuration.');
        }
      }
      this._acMirror();
      return;
    }

    if (mode === 'travel') this._acTravelTick(dt, input, ctl);
    else if (mode === 'flight') this._acFlightTick(dt, input, ctl);
    this._acMirror();
  }

  _acTransitionMove(dt) {
    // carry momentum gently through a transform
    const mm = this._acPilot._mm;
    const px = (this._acPilot.x ?? 0) + this._acVel.x * dt;
    const pz = (this._acPilot.z ?? 0) + this._acVel.z * dt;
    mm.teleport(px, pz, this._acPilot.y ?? 0);
    this._acVel.x *= Math.max(0, 1 - 1.5 * dt);
    this._acVel.z *= Math.max(0, 1 - 1.5 * dt);
  }

  /* -- TRAVEL: the Armored Core hover ------------------------------------- */

  _acTravelTick(dt, input, ctl) {
    const p = this._acPilot;
    const mm = p._mm;

    // the camera adopts the craft: once the boarding cinematic has actually
    // RELEASED the camera, park the orbit dead astern — setting it any
    // earlier lets the release overwrite it (Austin's wrong-side camera)
    if (!this._acCamSet && !this.world?._camCurveActive) {
      this._acCamBehind();
      this._acCamSet = true;
    }

    // E dismounts (the only exit door, per the rules)
    if (input.pressed(ctl.interact)) { this.unboard(); return; }
    // F folds into the jet
    if (input.pressed('KeyF PadY')) { this._acToFlight(); return; }

    const cam = this._acCam();
    // _yaw is the camera's BEARING from the character (where it sits);
    // the direction the player is LOOKING — the aim frame every camera-
    // relative control wants — is the opposite bearing.
    const camYaw = cam ? ((cam._yaw + 180) % 360) : this._acHeading;

    // stick, camera-relative
    let axF = (input.down(ctl.forward) ? 1 : 0) - (input.down(ctl.back) ? 1 : 0);
    let axR = (input.down(ctl.right) ? 1 : 0) - (input.down(ctl.left) ? 1 : 0);
    if (input.gamepadEnabled && input.stick) {
      const s = input.stick();
      axF += s.y; axR += s.x;
    }
    const mag = Math.min(1, Math.hypot(axF, axR));

    // the mech faces the camera's aim — AC's fourth-gen convention — but
    // ONLY under movement input: an idle craft holds its own heading (the
    // approach camera must never spin the parked-then-boarded unit around)
    if (mag > 0.05) {
      this._acHeading = turnToward(this._acHeading, camYaw, (Number(this.turnRate) || 240) * dt);
    }
    const cy = camYaw * AC_DEG;
    let dx = 0; let dz = 0;
    if (mag > 0.05) {
      // right of the aim is aim MINUS 90 in this world's heading convention
      // (heading = atan2(x, z), y-up right-handed) — the plus-90 basis
      // strafed mirrored (Austin's "A and D move the opposite directions")
      dx = (Math.sin(cy) * axF - Math.cos(cy) * axR) / (mag || 1);
      dz = (Math.cos(cy) * axF + Math.sin(cy) * axR) / (mag || 1);
      const n = Math.hypot(dx, dz) || 1;
      dx /= n; dz /= n;
    }

    // boost HELD vs QUICK-BOOST tapped — one key, split on release timing
    const boostKey = input.down('ShiftLeft ShiftRight PadLS PadA');
    let boosting = false;
    if (boostKey && this._acBoostT < 0) this._acBoostT = 0;
    if (this._acBoostT >= 0) {
      if (boostKey) {
        this._acBoostT += dt;
        boosting = this._acBoostT > 0.24;
      } else {
        if (this._acBoostT <= 0.24 && mag > 0.05 && this._acActT <= 0) {
          // QUICK BOOST: an instant burst — the a030/1 spin-evade clips are
          // OPT-IN (`useQBClips`): their full-body roll read wrong on a tap
          // while already moving (Austin), so by default only speed + rumble
          // sell the boost and the move cycle keeps playing.
          const imp = Number(this.qbImpulse) || 16;
          this._acVel.x += dx * imp;
          this._acVel.z += dz * imp;
          if (this.useQBClips === true || this.useQBClips === 'true') {
            const side = Math.sin(cy) * dz - Math.cos(cy) * dx; // + = burst left
            this._acPlay(String(side >= 0 ? this.clipQBL : this.clipQBR), { loop: false, fade: 0.08 });
            this._acActT = 0.55;
          }
          this.world?.input3d?.rumble?.(0.5, 0.8, 140);
        }
        this._acBoostT = -1;
      }
    }

    // attacks (one-shots lock the clip channel briefly)
    if (this._acActT <= 0) {
      if (input.pressed(ctl.primary)) {
        this._acPlay(String(this.clipMeleeAtk), { loop: false, fade: 0.08 });
        this._acActT = 1.1;
        this._acHidePilot(true); // the hull swings through the seat
        const h = this._acHeading * AC_DEG;
        this._acVel.x += Math.sin(h) * 7;
        this._acVel.z += Math.cos(h) * 7;
        this._acFx(this.strikeFx);
        this._acStrike();
      } else if (input.pressed(ctl.secondary)) {
        // AOE BLAST (Austin's spec): the thin translucent orb, the enemy
        // stomp's own effect, now friendly — grows from the craft and
        // damages every enemy its front passes, each once
        this._acPlay(String(this.clipShootAtk), { loop: false, fade: 0.08 });
        this._acActT = 0.9;
        this._acHidePilot(true); // the hull's attack swings through the seat
        this._acFx(this.blastFx);
        this._acSpawnWave();
        this.world?.loop?.hitStop?.(0.06, 0.08);
        this.world?.input3d?.rumble?.(0.6, 0.9, 220);
      }
    } else {
      this._acActT -= dt;
      if (this._acActT <= 0) this._acHidePilot(false);
    }

    // inertial hover: accelerate toward the stick, exponential drag off it
    const top = boosting ? (Number(this.travelBoost) || 22) : (Number(this.travelSpeed) || 12);
    const acc = Number(this.travelAccel) || 26;
    if (mag > 0.05) {
      this._acVel.x += dx * acc * mag * dt;
      this._acVel.z += dz * acc * mag * dt;
    }
    const sp = Math.hypot(this._acVel.x, this._acVel.z);
    if (sp > top) {
      const k = 1 - Math.min(1, 3 * dt);
      const want = top + (sp - top) * k; // bursts bleed off, never snap
      this._acVel.x *= want / sp;
      this._acVel.z *= want / sp;
    }
    if (mag <= 0.05) {
      const k = Math.max(0, 1 - (Number(this.travelDrag) || 5) * dt);
      this._acVel.x *= k;
      this._acVel.z *= k;
    }

    // terrain-following hover: rises with the ground, DESCENDS slowly (the
    // thruster fall) — input never climbs it, per the mode's rules
    const px = (p.x ?? 0) + this._acVel.x * dt;
    const pz = (p.z ?? 0) + this._acVel.z * dt;
    let py = p.y ?? 0;
    const g = this._acGround(px, pz, py + 6);
    if (Number.isFinite(g)) {
      const target = g + (Number(this.hoverHeight) || 1.6) + (Number(this.seatHeight) || 0);
      const dy = target - py;
      const rate = dy > 0 ? (Number(this.hoverRise) || 9) : (Number(this.hoverFall) || 3.5);
      py += Math.max(-rate * dt, Math.min(rate * dt, dy));
    }
    mm.teleport(px, pz, py);
    mm.setYaw(this._acHeading * AC_DEG);

    // clip channel: idle / move / boost (one-shots own it while _acActT > 0)
    if (this._acActT <= 0) {
      const moving = Math.hypot(this._acVel.x, this._acVel.z);
      this._acPlay(String(boosting && moving > 4 ? this.clipTravelBoost
        : moving > 1.5 ? this.clipTravelMove : this.clipTravelIdle), { loop: true });
      // the travel loops are the aaf0-family 361f cycles, same length as her
      // riding pose — slave the hull's phase to her clock (one-shots excluded:
      // a QB or an attack runs its own length, unpaired)
      if (!mm.inAction) this._acPilotAction(this.pilotRide); // self-heal
      this._acSync(mm);
    }
    p._flightCam = null;
  }

  _acToFlight() {
    this._acSetMode('toFlight');
    this._acActT = Number(this.toFlightTime) || 2.6;
    // §18.53 flight LOD: the whole map drops to its decimated twins for the
    // duration of flight — the transform curve + seam flash hide the swap,
    // and at flight speed/altitude the decimation is invisible (22→13 ms).
    this.world?.env3d?.setLodFar?.(true);
    this._acHidePilot(true); // the fold swallows the cockpit
    this._acPilotAction(this.pilotTransform);
    this._acPlay(String(this.clipToFlight), { loop: false, fade: 0.12 });
    this._acCourse(this.toFlightCurve);
    this._acFx(this.seamFx); // the fold flash
    this.world?.input3d?.rumble?.(0.4, 0.7, 300);
  }

  /* -- FLIGHT: the Ace Combat chase --------------------------------------- */

  _acFlightTick(dt, input, ctl) {
    const p = this._acPilot;
    const mm = p._mm;

    // F unfolds — only near enough to the ground for the hover to catch
    if (input.pressed('KeyF PadY')) {
      const g = this._acGround(p.x ?? 0, p.z ?? 0, (p.y ?? 0) + 2);
      const alt = Number.isFinite(g) ? (p.y ?? 0) - g : Infinity;
      if (alt <= (Number(this.travelEnterHeight) || 7)) {
        this._acSetMode('toTravel');
        this.world?.env3d?.setLodFar?.(false); // full detail returns with the ground
        this._acActT = Number(this.toTravelTime) || 1.2;
        this._acPilotAction(this.pilotTransformBack);
        this._acPlay(String(this.clipToTravel), { loop: false, fade: 0.12 });
        this._acFx(this.seamFx); // the unfold flash
        this.world?.input3d?.rumble?.(0.4, 0.7, 300);
        return;
      }
      console.log('[Aircraft] too high to unfold — descend first.');
    }

    // AC6 hands: stick = pitch/roll; keyboard W/S pitch, A/D roll,
    // Shift throttle, Ctrl brake. Roll turns the nose (bank-to-turn).
    let pit = (input.down(ctl.forward) ? -1 : 0) + (input.down(ctl.back) ? 1 : 0);
    let rol = (input.down(ctl.right) ? 1 : 0) - (input.down(ctl.left) ? 1 : 0);
    if (input.gamepadEnabled && input.stick) {
      const s = input.stick();
      pit += s.y; rol += s.x;
    }
    const thrUp = input.down('ShiftLeft ShiftRight PadRT PadA');
    const thrDn = input.down('ControlLeft ControlRight PadLT PadB');

    const pitchRate = Number(this.pitchRate) || 65;
    const rollMax = Number(this.rollMax) || 65;
    this._acPitch = Math.max(-70, Math.min(70,
      this._acPitch + pit * pitchRate * dt * (this._acPitch * pit > 0 ? 1 : 1.6)));
    if (Math.abs(pit) < 0.05) this._acPitch = turnToward(this._acPitch, 0, 18 * dt);
    this._acBank = Math.max(-rollMax, Math.min(rollMax, this._acBank + rol * 160 * dt));
    if (Math.abs(rol) < 0.05) this._acBank = turnToward(this._acBank, 0, 70 * dt);
    this._acHeading += (this._acBank / rollMax) * (Number(this.bankTurnRate) || 90)
      * Math.cos(this._acPitch * AC_DEG) * dt;

    const vMin = Number(this.flightMin) || 14;
    const vMax = Number(this.flightMax) || 55;
    const thr = (thrUp ? 1 : 0) - (thrDn ? 1 : 0);
    this._acSpeed += thr * (Number(this.throttleRate) || 14) * dt;
    // gravity breathes through the nose: dives gain, climbs bleed
    this._acSpeed += -Math.sin(this._acPitch * AC_DEG) * 6 * dt;
    this._acSpeed = Math.max(vMin, Math.min(vMax, this._acSpeed));

    // attack: the strafing-run clip
    if (this._acActT > 0) this._acActT -= dt;
    else if (input.pressed(ctl.primary) || input.pressed(ctl.secondary)) {
      this._acPlay(String(this.clipCruiseAtk), { loop: false, fade: 0.1 });
      this._acActT = 1.2;
      this.world?.input3d?.rumble?.(0.35, 0.7, 160);
    }

    // integrate along the nose
    const h = this._acHeading * AC_DEG;
    const cp = Math.cos(this._acPitch * AC_DEG);
    const px = (p.x ?? 0) + Math.sin(h) * cp * this._acSpeed * dt;
    const pz = (p.z ?? 0) + Math.cos(h) * cp * this._acSpeed * dt;
    let py = (p.y ?? 0) + Math.sin(this._acPitch * AC_DEG) * this._acSpeed * dt;

    // the ground is not negotiable: skim, level out
    const g = this._acGround(px, pz, py + 30);
    if (Number.isFinite(g) && py < g + 2) {
      py = g + 2;
      if (this._acPitch < 0) this._acPitch = turnToward(this._acPitch, 6, 220 * dt);
    } else if (!Number.isFinite(g) && py < (Number(this.voidFloor) ?? -20)) {
      // past the map's edge nothing answers the ray — hold a floor so a
      // dive over the void can't corkscrew into forever (measured: −19 m
      // and falling, first test flight off the nine-tile shelf)
      py = Number(this.voidFloor) ?? -20;
      if (this._acPitch < 0) this._acPitch = turnToward(this._acPitch, 4, 160 * dt);
    }
    mm.teleport(px, pz, py);
    mm.setYaw(h);

    // clip channel: CRUISE, always — banking is the element's roll, not a
    // clip: the baked Bank_L/R (a532/3) are full authored barrel-roll
    // cycles, and swapping to them on stick-left read as "a strange spin"
    // (Austin). `(useBankClips true)` re-arms them for a craft whose bank
    // clips really are subtle leans.
    if (this._acActT <= 0) {
      const useBank = this.useBankClips === true || this.useBankClips === 'true';
      this._acPlay(String(useBank && this._acBank < -26 ? this.clipBankL
        : useBank && this._acBank > 26 ? this.clipBankR : this.clipCruise), { loop: true });
    }

    // the chase camera request — consumed by AE1ThirdPersonCamera (§18.52)
    const spN = (this._acSpeed - vMin) / Math.max(1, vMax - vMin);
    p._flightCam = {
      yaw: this._acHeading,
      pitch: this._acPitch,
      roll: -this._acBank * 0.45,
      dist: Number(this.flightCamDist) || 9,
      height: Number(this.flightCamHeight) || 2.4,
      lag: Number(this.flightCamLag) || 4.5,
      fov: (Number(this.fovCruise) || 55) + spN * ((Number(this.fovFast) || 72) - (Number(this.fovCruise) || 55)),
    };
  }

  /* -- combat -------------------------------------------------------------- */

  /** The friendly AOE (§18.52): an orb wave centered on the craft — the
   *  enemy attack element reused with `_friendly` on, so it damages every
   *  takeDamage target its front passes and spares the pilot. */
  _acSpawnWave() {
    const scn = this.world?.scene;
    const p = this._acPilot;
    if (!scn || !p) return;
    const b = this.world?.env3d?.boundsOf?.(this);
    const media = String(this.aoeMedia || '');
    const el = new AE1AoeWave({
      id: 'acwave-' + Math.random().toString(36).slice(2, 10),
      name: '__AoeWave',
      type: 'object',
      visible: true,
      x: p.x ?? 0,
      y: b ? (b.min.y + b.max.y) / 2 : (p.y ?? 0) + 1,
      z: p.z ?? 0,
      scaleX: 0.1,
      scaleY: 0.1,
      scaleZ: 0.1,
      // an EMPTY aoeMedia = an invisible wave: the damage front still
      // expands, and a Particles burst (blastFx) carries the whole visual
      // (Austin retired the orange orb on the flight unit)
      ...(media ? { components: { model: { media, node: 'aoe_orb' } } } : {}),
    });
    el._mode = 'orb';
    el._friendly = true;
    el._speed = Number(this.aoeSpeed) || 10;
    el._maxR = Number(this.aoeRadius) || 9;
    el._damage = Number(this.aoeDamage) || 30;
    el._attacker = p; // kills credit the pilot, not the costume
    scn.add(el);
    this.world?.loop?.rescan?.();
  }

  _acStrike() {
    // frontal-arc melee: anything with takeDamage inside reach eats it
    const p = this._acPilot;
    const reach = Number(this.attackReach) || 5;
    const dmg = Number(this.attackDamage) || 40;
    const h = this._acHeading * AC_DEG;
    let hitAny = false;
    let killed = false;
    for (const el of this.world?.scene?.all() ?? []) {
      if (el === this || el === p || typeof el.takeDamage !== 'function') continue;
      if (el._dead) continue;
      const dx = (el.x ?? 0) - (p.x ?? 0);
      const dz = (el.z ?? 0) - (p.z ?? 0);
      const d = Math.hypot(dx, dz);
      if (d > reach) continue;
      const bearing = Math.atan2(dx, dz);
      let off = (bearing - h) / AC_DEG;
      off = ((off + 540) % 360) - 180;
      if (Math.abs(off) > (Number(this.attackArc) || 75)) continue;
      el.takeDamage(dmg, this);
      hitAny = true;
      if (el._dead || Number(el.health) <= 0) killed = true;
    }
    if (killed) {
      // THE KILL FLASH: a blade that finishes something earns the slow-mo
      // beat and the burst — the combat-feel doctrine (§18.41), mech-sized
      this._acFx(this.killFx);
      this.world?.loop?.slowMo?.(0.5, 0.2, 0.3);
      this.world?.input3d?.rumble?.(1, 0.7, 320);
    } else if (hitAny) {
      this.world?.loop?.hitStop?.(0.09, 0.05);
      this.world?.input3d?.rumble?.(0.9, 0.5, 200);
    }
  }

  _acAbort() {
    // pilot vanished (scene change, death) — fold everything back safely
    this._acPilot = null;
    this._acSetMode('parked');
    this._acPlay(String(this.clipIdle), { loop: true });
    this._acCamRestore();
  }
}

AE1Aircraft.agsDef = {
  name: 'Aircraft',
  extends: null,
  runInfo: { _acTick: ['onTick'] },
};

AE1Aircraft.agsDat = {
  // -- the seat (pilot root <-> hull), same knobs the flight trigger tuned --
  seatHeight: 0,
  seatForward: 0,
  seatYaw: 0,
  boardForward: -1.1,
  // -- unit-side clips (names inside this element's glb) --------------------
  clipIdle: 'Idle',
  clipBoard: 'Board',
  clipUnboard: 'Unboard',
  clipTravelIdle: 'Cockpit',
  clipTravelMove: 'Travel_Move',
  clipTravelBoost: 'Travel_Boost',
  clipQBL: 'QB_L',
  clipQBR: 'QB_R',
  useQBClips: false,
  clipMeleeAtk: 'Attack_Melee',
  clipShootAtk: 'Attack_Shoot',
  clipToFlight: 'ToFlight',
  clipToTravel: 'ToTravel',
  clipCruise: 'Cruise',
  clipBankL: 'Bank_L',
  clipBankR: 'Bank_R',
  useBankClips: false,
  clipCruiseAtk: 'Cruise_Attack',
  // -- pilot-side actions (her retargeted pairs, named in the mm packs) -----
  pilotBoard: 'Flight_Board',
  pilotExit: 'Flight_Exit',
  pilotRide: 'Flight_Cockpit',
  pilotProne: 'Flight_Prone',
  pilotTransform: 'Flight_Transform',
  pilotTransformBack: 'Flight_TransformBack',
  // -- travel (Asura) physics ----------------------------------------------
  hoverHeight: 1.6,
  travelSpeed: 12,
  travelBoost: 22,
  travelAccel: 26,
  travelDrag: 5,
  qbImpulse: 16,
  turnRate: 240,
  hoverRise: 9,
  hoverFall: 3.5,
  // -- flight (Cygnus) physics ---------------------------------------------
  flightMin: 14,
  flightMax: 55,
  throttleRate: 14,
  pitchRate: 65,
  rollMax: 65,
  bankTurnRate: 90,
  travelEnterHeight: 7,
  toFlightTime: 2.6,
  toTravelTime: 1.2,
  voidFloor: -20,
  boardCutTime: 0.6,
  exitDropHeight: 1.4,
  // -- combat ---------------------------------------------------------------
  attackDamage: 40,
  attackReach: 5,
  attackArc: 75,
  aoeDamage: 30,
  aoeRadius: 9,
  aoeSpeed: 10,
  aoeMedia: '', // empty = invisible wave, the blastFx burst is the visual
  // -- presentation ---------------------------------------------------------
  hidePilotInFlight: true,
  travelCamDist: 8,
  flightCamDist: 9,
  flightCamHeight: 2.4,
  flightCamLag: 4.5,
  fovCruise: 55,
  fovFast: 72,
  // camera curve/course ELEMENT NAMES conducted at each transition
  boardCourse: '',
  exitCourse: '',
  toFlightCurve: '',
  // Particles ELEMENT NAMES (§18.52): burst at each seam; thruster loops
  // while piloted. Empty = no effect.
  thrusterFx: '',
  seamFx: '',
  strikeFx: '',
  blastFx: '',
  killFx: '',
};

defineDatAccessors(AE1Aircraft);
