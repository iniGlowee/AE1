/**
 * AE1 - the third-person kit: Controller, ThirdPersonCamera, ThirdPersonCharacter.
 *
 * Three built-ins that together make a playable third-person scene, each
 * extendable from Angel Script (DESIGN.md Â§18.9):
 *
 *  - `Controller` is DATA: the key/mouse mappings, editable in Properties.
 *    The character asks it "which code means forward?", so rebinding is a dat
 *    edit, never a code change. No controller in the scene? Class defaults.
 *  - `ThirdPersonCamera` orbits the character: mouse look moves yaw/pitch,
 *    idling lets you inspect your own character without moving it. It writes
 *    plain base-element transform fields (x/y/z, rotationX/rotationY) â€” the
 *    renderer applies them to the view ONLY during play. The editor viewport
 *    keeps its own orbit camera; this element never touches it.
 *  - `ThirdPersonCharacter extends Model` (so animation aliases slot straight
 *    in later): camera-relative WASD, gravity + jump onto raycast ground,
 *    turning to face travel. ONE per scene â€” a second one goes inert, loudly.
 *
 * Everything here is plain math on element fields. No three.js: the one thing
 * that needs geometry â€” "what height is the ground at (x, z)?" â€” is INJECTED by
 * whoever mounts the renderer (`world.env3d.groundAt`, from render3d's
 * raycaster). So the same scripts run in the editor viewport and the shipped
 * game, and this file ships in the classic bundle untouched (Principle 2).
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Model } from './model3d.js';
import { AE1Hitbox } from './hitbox.js';
import { AE1LockMarker } from './lockmarker.js';

const DEG = Math.PI / 180;

/** Shortest-path angle lerp, degrees. Turning 350Â°â†’10Â° goes 20Â°, not âˆ’340Â°. */
export function turnToward(current, target, maxStep) {
  let d = ((target - current + 540) % 360) - 180;
  if (d > maxStep) d = maxStep;
  if (d < -maxStep) d = -maxStep;
  return current + d;
}

/* -- a minimal quaternion kit -------------------------------------------- *
 *
 * Here because FACING IS NOT rotationY. A glTF armature routinely ships a
 * baked rest rotation (Blender's Z-up exports carry rotationX 90), and the
 * element euler renders as RxÂ·RyÂ·Rz â€” so writing rotationY alone turns the
 * model about a TILTED axis: walking backwards flipped the character upside
 * down under the floor. The character's heading must be a WORLD yaw composed
 * onto the rest orientation, M = Ry(Î”)Â·M_rest, and that needs quaternions.
 * Hand-rolled (~30 lines) because the engine's element layer never imports
 * three.js (Â§18.9).                                                          */

/** Degrees euler (XYZ, three's order: M = RxÂ·RyÂ·Rz) -> quaternion. */
export function qFromEulerXYZ(rx, ry, rz) {
  const hx = (rx * DEG) / 2, hy = (ry * DEG) / 2, hz = (rz * DEG) / 2;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

/** Hamilton product a âŠ— b (apply b, then a). */
export function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** A yaw (world up) of `deg` degrees. */
export function qYaw(deg) {
  const h = (deg * DEG) / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** How much of q is yaw about world up, in degrees. 0 when degenerate. */
export function qTwistYDeg(q) {
  if (Math.hypot(q.w, q.y) < 1e-6) return 0;
  return (2 * Math.atan2(q.y, q.w)) / DEG;
}

/** Quaternion -> degrees euler in three's XYZ convention. */
export function qToEulerXYZ(q) {
  const { x, y, z, w } = q;
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const m12 = 2 * (x * y - w * z);
  const m11 = 1 - 2 * (y * y + z * z);
  return {
    x: Math.atan2(-m23, m33) / DEG,
    y: Math.asin(Math.max(-1, Math.min(1, m13))) / DEG,
    z: Math.atan2(-m12, m11) / DEG,
  };
}

/* ------------------------------------------------------------------------- */

export class AE1Controller extends AE1Element {
  /** The scene's controller mappings â€” first Controller element, else the
   *  class defaults. Static so character/camera can ask without an instance. */
  static mappingsIn(world) {
    // Â§18.87: this ran scene.all() (a fresh array spread) plus a linear
    // instanceof scan several times per character per frame. The answer
    // only changes with the scene â€” cache the FOUND controller on the
    // world, keyed by scene identity; a miss re-scans (cheap, rare).
    const sc = world?.scene;
    if (!sc) return AE1Controller.agsDat;
    if (world._ctlCacheScene !== sc || !world._ctlCache) {
      world._ctlCacheScene = sc;
      world._ctlCache = sc.all().find((e) => e instanceof AE1Controller) ?? null;
    }
    return world._ctlCache ?? AE1Controller.agsDat;
  }
}

/** Â§18.87: the scene's play camera, cached the same way (was a per-frame
 *  scene scan at every call site in the character tick). */
export function cameraIn(world) {
  const sc = world?.scene;
  if (!sc) return null;
  if (world._camCacheScene !== sc || !world._camCache) {
    world._camCacheScene = sc;
    world._camCache = sc.all().find((e) => e instanceof AE1ThirdPersonCamera) ?? null;
  }
  return world._camCache;
}

AE1Controller.agsDef = {
  name: 'Controller',
  extends: null,
  runInfo: {},
};

/** Is this world's Controller taking GAMEPAD input right now? Scripts flip it
 *  live (`ctl.gamepad = false` â€” a settings menu's keyboard/controller
 *  toggle); dat booleans may arrive as the symbol "false". */
export function gamepadOn(ctl) {
  return !(ctl.gamepad === false || ctl.gamepad === 'false');
}

/**
 * One string per action â€” and a string may name ALTERNATIVES, space-separated
 * (`KeyboardEvent.code` names, `Mouse0`/`Mouse2`, and pad buttons `PadA PadB
 * PadX PadY PadLB PadRB PadLT PadRT PadSelect PadStart PadLS PadRS PadUp
 * PadDown PadLeft PadRight`): any held one fires. `sensitivity` is look
 * degrees per pixel; `padLookSpeed` degrees/second at full right-stick.
 *
 * `(gamepad false)` turns the controller OFF â€” sticks, pad buttons, the lot â€”
 * which is the switch a settings menu exposes to players. The defaults give
 * the standard layout: left stick move (ANALOG â€” the matcher walks at half
 * stick), right stick orbit, A jump, X interact, RT attack, LB aim/secondary,
 * B crouch, LT/LS run, dpad up/down cycles the inventory.
 */
AE1Controller.agsDat = {
  gamepad: true,
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space PadA',
  primary: 'Mouse0 PadRT',
  secondary: 'Mouse2 PadLB',
  interact: 'KeyE PadX',
  // Â§18.43: toggle lock-on â€” right-stick CLICK on a pad, Z on the keyboard.
  // Opt-in by nature: never pressing it never changes anything.
  lockOn: 'KeyZ PadRS',
  sensitivity: 0.15,
  padLookSpeed: 180,
  invertY: false,
};

defineDatAccessors(AE1Controller);

/* ------------------------------------------------------------------------- */

export class AE1ThirdPersonCamera extends AE1Element {
  /** Orbit state, runtime-only â€” dat holds the FEEL, this holds the angle. */
  _yaw = 0; // degrees, azimuth around the character
  _pitch = 12; // degrees, positive = above, looking down

  _camBegin() {
    // Start behind whatever the character faces, so play opens over-the-shoulder.
    // `_heading` is the character's true world yaw â€” rotationY is NOT (a baked
    // armature rest makes the euler fields non-obvious; see the quat kit).
    const t = this._target();
    if (t) this._yaw = ((t._heading ?? t.rotationY ?? 0) + 180) % 360;
  }

  _target() {
    // Â§18.82: with several playable characters in the scene (possession),
    // the camera belongs to the one NOT on autopilot; parked bodies are
    // scenery. Falls back to the first character when everything is parked.
    const all = this.world?.scene?.all() ?? [];
    let first = null;
    for (const e of all) {
      if (!(e instanceof AE1ThirdPersonCharacter)) continue;
      if (!(e.autopilot === true || e.autopilot === 'true')) return e;
      first = first ?? e;
    }
    return first;
  }

  _camTick(dt) {
    const t = this._target();
    const input = this.world?.input3d;
    if (!t) return;

    // -- Â§18.49 CAMERA CURVE HANDOVER --------------------------------------- //
    // While a CharacterCameraCurve holds the camera, its sample IS the view:
    // position + a look-at, converted to this camera's YXZ fields. The orbit
    // (and the Fox layers below) resume the frame the curve releases. _yaw/
    // _pitch stay untouched, so control returns exactly where the player
    // left it.
    const cc = this.world?._camCurveActive;
    if (cc && cc._ccSample) {
      const s = cc._ccSample;
      this.x = s.x;
      this.y = s.y;
      this.z = s.z;
      const dx = s.x - s.lx;
      const dy = s.y - s.ly;
      const dz = s.z - s.lz;
      this.rotationY = Math.atan2(dx, dz) / DEG;
      this.rotationX = -Math.atan2(dy, Math.hypot(dx, dz)) / DEG;
      this.rotation = 0;
      this._camPlaced = false; // the orbit re-snaps cleanly afterwards
      // DISCARD look input while the curve owns the camera: deltas otherwise
      // accumulate unconsumed for the whole shot and dump into _yaw in one
      // frame at release â€” the orbit resumed on a random side (Austin's
      // "camera in front of the flight unit" after the boarding cinematic).
      input?.consumeLook?.();
      return;
    }

    // -- Â§18.52 THE FLIGHT CHASE ------------------------------------------- //
    // A piloted Aircraft in jet mode publishes `pilot._flightCam` every tick
    // (heading/pitch/roll/dist/fov); this camera flies formation: eased
    // position behind the craft's nose vector, banked with it, FOV opening
    // with airspeed. The field clearing (dismount, unfold, mode change)
    // hands the fox orbit back on the very next frame.
    const fc = t._flightCam;
    if (fc) {
      const fy = fc.yaw * DEG;
      const fp = (fc.pitch ?? 0) * DEG;
      const cx = (t.x ?? 0) - Math.sin(fy) * Math.cos(fp) * fc.dist;
      const cz = (t.z ?? 0) - Math.cos(fy) * Math.cos(fp) * fc.dist;
      const cy = (t.y ?? 0) + fc.height - Math.sin(fp) * fc.dist * 0.45;
      const k = 1 - Math.exp(-(fc.lag ?? 4.5) * dt);
      if (!this._fcOn) { this.x = cx; this.y = cy; this.z = cz; this._fcOn = true; }
      else {
        this.x += (cx - this.x) * k;
        this.y += (cy - this.y) * k;
        this.z += (cz - this.z) * k;
      }
      // look THROUGH the craft at a point ahead of the nose
      const ax = (t.x ?? 0) + Math.sin(fy) * Math.cos(fp) * 14;
      const az = (t.z ?? 0) + Math.cos(fy) * Math.cos(fp) * 14;
      const ay = (t.y ?? 0) + 1 + Math.sin(fp) * 14;
      const dx = this.x - ax;
      const dy = this.y - ay;
      const dz = this.z - az;
      this.rotationY = Math.atan2(dx, dz) / DEG;
      this.rotationX = -Math.atan2(dy, Math.hypot(dx, dz)) / DEG;
      this.rotation = fc.roll ?? 0;
      if (Number.isFinite(fc.fov)) this.fov = fc.fov;
      // keep _yaw tracking the craft so the orbit resumes BEHIND it
      // (orbit convention: _yaw is the camera's bearing FROM the character)
      this._yaw = ((fc.yaw + 180) % 360 + 360) % 360;
      this._pitch = 8;
      this._camPlaced = false;
      input?.consumeLook?.(); // same discard: no backlog dump on release
      return;
    }
    if (this._fcOn) {
      this._fcOn = false;
      this.rotation = 0; // never leave a banked horizon on the orbit
    }

    this._lookMoved = false;
    {
      // desired orbit deltas this frame (degrees), gathered from mouse+stick
      let wantYaw = 0;
      let wantPitch = 0;
      let rawMag = 0;
      if (input?.looking) {
        const ctl = AE1Controller.mappingsIn(this.world);
        const sens = Number(ctl.sensitivity) || 0.15;
        const { dx, dy } = input.consumeLook();
        wantYaw -= dx * sens;
        wantPitch += dy * sens * (ctl.invertY ? -1 : 1);
        // RIGHT STICK orbits too (rate-based: deg/s at full deflection), when
        // the Controller's (gamepad â€¦) toggle is on â€” the keyboard/controller
        // switch a settings menu exposes.
        input.gamepadEnabled = gamepadOn(ctl);
        let sx = 0, sy = 0;
        if (input.gamepadEnabled && input.lookStick) {
          ({ x: sx, y: sy } = input.lookStick());
          const rate = (Number(ctl.padLookSpeed) || 180) * dt;
          wantYaw -= sx * rate;
          wantPitch += sy * rate * 0.66 * (ctl.invertY ? -1 : 1);
        }
        rawMag = Math.abs(dx) + Math.abs(dy) * 1 + (Math.abs(sx) + Math.abs(sy)) * 5;
      }
      // ARROW-KEY camera rotation (the reference MMO-style). Opt-in via cursor mode so
      // free-look projects keep the arrows for whatever they use them for.
      if (input?.cursorMode) {
        const kr = (Number(this.keyLookSpeed) || 120) * dt; // deg/s
        let ky = 0, kp = 0;
        if (input.down('ArrowLeft')) ky += kr;
        if (input.down('ArrowRight')) ky -= kr;
        if (input.down('ArrowUp')) kp -= kr;
        if (input.down('ArrowDown')) kp += kr;
        wantYaw += ky; wantPitch += kp;
        if (ky || kp) rawMag += 5;
      }
      // -- Â§18.61 LOOK MOMENTUM: a touch of mass on the orbit --------------- //
      // The MGSV doctrine kept input RAW; Austin asked for "just a little"
      // inertia â€” so the orbit is carried by a smoothed VELOCITY: input
      // accelerates it in over `lookSmooth` seconds and, when input stops,
      // it decelerates out over the same constant (the glide). 0 = raw.
      const sm = Math.max(0, Number(this.lookSmooth) || 0);
      if (sm > 0 && dt > 0) {
        const k = Math.min(1, dt / sm);
        this._lookVy = (this._lookVy ?? 0) + (wantYaw / dt - (this._lookVy ?? 0)) * k;
        this._lookVp = (this._lookVp ?? 0) + (wantPitch / dt - (this._lookVp ?? 0)) * k;
        this._yaw += this._lookVy * dt;
        this._pitch += this._lookVp * dt;
        this._lookMoved = rawMag > 0.5 || Math.abs(this._lookVy) > 8;
      } else {
        this._yaw += wantYaw;
        this._pitch += wantPitch;
        this._lookMoved = rawMag > 0.5;
      }
      const lo = Number(this.minPitch), hi = Number(this.maxPitch);
      this._pitch = Math.max(Number.isFinite(lo) ? lo : -60, Math.min(Number.isFinite(hi) ? hi : 75, this._pitch));
    }

    // LOCK-ON (Â§18.43): while the character holds a living target, the
    // camera owns its own yaw â€” eased onto the playerâ†’target bearing so the
    // enemy stays centered, Souls-style. Pitch settles to a fixed combat
    // angle; the sticks keep working the moment the lock drops. Opt-in by
    // nature: no lock, no change.
    const lt = t._lockTarget;
    if (lt && !lt._dead && lt.visible !== false) {
      const desired =
        Math.atan2((t.x ?? 0) - (lt.x ?? 0), (t.z ?? 0) - (lt.z ?? 0)) / DEG;
      this._yaw = turnToward(this._yaw, desired, (Number(this.lockYawSpeed) || 240) * dt);
      const wantPitch = Number(this.lockPitch) || 16;
      this._pitch += (wantPitch - this._pitch) * Math.min(1, 4 * dt);
    }

    // -- Â§18.47 THE FOX CAMERA ------------------------------------------- //
    // MGSV's model, from the research: input rotation stays RAW (never
    // smooth the stick â€” low latency is the whole feel), while camera
    // POSITION chases the pivot through a damped spring whose lag loosens
    // with speed (idle: composed; sprint: the character visibly leads, the
    // chase-cameraman drag). On top rides a 3-octave handheld sway â€” a slow
    // wander, a mid tremor, a tiny high shiver, plus a gait-locked octave
    // that only sprint wakes â€” applied to the OUTPUT rotation only, so
    // steering, lock-on, and aim math keep reading clean _yaw/_pitch.
    // `(handheld 0)` is MGSV's own Camera Shake toggle.
    const spdNow = Number(t._mm?.speed) || 0;
    this._camSpd = (this._camSpd ?? 0)
      + (spdNow - (this._camSpd ?? 0)) * Math.min(1, dt / 0.35);
    const e = Math.max(0, Math.min(1, (this._camSpd - 0.4) / 6.6)); // idleâ†’sprint
    const hh = Math.max(0, Number(this.handheld ?? 1));

    // Spherical offset behind the look point, then face back at it.
    // Â§18.85 FIRST_PERSON (debug wall): the orbit math makes this one
    // number â€” rotation comes from _yaw/_pitch regardless of position, so
    // a NEGATIVE distance parks the camera just ahead of the face, looking
    // the character's own forward. Head and hair sit BEHIND the camera (no
    // near-plane gore), mouse look still steers, and the possession rule
    // in _target() means it always rides the active body.
    const fp = !!this.world?.debugFlags?.FIRST_PERSON;
    const yaw = this._yaw * DEG;
    const pitch = this._pitch * DEG;
    // §scroll-zoom: the wheel dollies the orbit distance in/out (the reference MMO-style),
    // clamped to [zoomMin, zoomMax]. Opt-in via (wheelZoom true) so projects that
    // spend the wheel elsewhere (inventory cycling) are unaffected. The base
    // `distance` is the starting zoom.
    if (this.wheelZoom === true || this.wheelZoom === 'true') {
      const w = input?.consumeWheel?.() || 0;
      const base = Number(this.distance) || 3.5;
      this._zoomDist = this._zoomDist ?? base;
      if (w) this._zoomDist = Math.max(Number(this.zoomMin) || 2,
        Math.min(Number(this.zoomMax) || 24, this._zoomDist + w * (Number(this.zoomStep) || 1.5)));
    }
    const distNow = (this.wheelZoom === true || this.wheelZoom === 'true')
      ? (this._zoomDist ?? (Number(this.distance) || 3.5)) : (Number(this.distance) || 3.5);
    const d = fp ? -(Number(this.fpAhead) || 0.3)
      : distNow + e * (Number(this.distSprintAdd) || 0.4);
    const look = {
      x: t.x ?? 0,
      y: (t.y ?? 0) + (Number(this.lookHeight) || 1.6) - e * (Number(this.runLower) || 0.22),
      z: t.z ?? 0,
    };
    // MGSV shoulder framing: the pivot slides along the camera's RIGHT so
    // the character sits a third off-center instead of dead middle.
    // (Off in first person â€” an offset eye reads as a broken neck.)
    const shoulder = fp ? 0 : Number(this.shoulder) || 0;
    if (shoulder) {
      look.x += Math.cos(yaw) * shoulder;
      look.z += -Math.sin(yaw) * shoulder;
    }
    const dirx = Math.sin(yaw) * Math.cos(pitch);
    const diry = Math.sin(pitch);
    const dirz = Math.cos(yaw) * Math.cos(pitch);
    let ix = look.x + dirx * d;
    let iy = look.y + diry * d;
    let iz = look.z + dirz * d;
    // §third-person collision: pull the boom IN so it never clips through a wall
    // or roof (the reference MMO zooms the camera in when the view is blocked). Cast from
    // the look point toward the ideal camera spot; the character itself is
    // excluded (the ray starts inside it). Opt-out with (camCollide false); only
    // meaningful for a positive-distance third-person boom.
    if (d > 0 && this.camCollide !== false && this.camCollide !== 'false') {
      const env = this.world?.env3d;
      const selfObj = env?.objectFor?.(t) ?? null;
      const hitDist = env?.cameraClip?.(look.x, look.y, look.z, ix, iy, iz, selfObj);
      if (hitDist != null) {
        const margin = Number(this.camMargin) || 0.3;
        const dd = Math.max(Number(this.camMinDist) || 0.6, hitDist - margin);
        ix = look.x + dirx * dd;
        iy = look.y + diry * dd;
        iz = look.z + dirz * dd;
      }
    }
    // per-axis damped chase, Y heavier (the camera floats over terrain,
    // never bounces with footsteps); a teleport/scene entry snaps.
    const lagXZ = (Number(this.chaseLag) || 0.08)
      + e * ((Number(this.chaseLagSprint) || 0.3) - (Number(this.chaseLag) || 0.08));
    const far = Math.hypot(ix - (this.x ?? 0), iy - (this.y ?? 0), iz - (this.z ?? 0));
    // First person snaps every frame: the Fox chase-lag is the third-person
    // cameraman's drag, but at the eyes it reads as your head swimming
    // loose from your body.
    if (far > 4 || !this._camPlaced || fp) {
      this._camPlaced = true;
      this.x = ix; this.y = iy; this.z = iz;
    } else {
      const kXZ = Math.min(1, dt / Math.max(0.01, lagXZ));
      const kY = Math.min(1, dt / Math.max(0.01, lagXZ * 1.6));
      this.x += (ix - this.x) * kXZ;
      this.z += (iz - this.z) * kXZ;
      this.y += (iy - this.y) * kY;
    }

    // -- the handheld sway (Â§18.61: slow BEATS, not machine sines) -------- //
    // The first cut ran pure sines up to 9 Hz â€” the "tiny shiver" read as
    // motorized vibration (Austin: rigid, fast, dizzying). Now each octave
    // is a PAIR of nearby frequencies beating against each other, so the
    // amplitude itself swells and fades over ~10 s: drift, the way a held
    // camera actually wanders. No octave above ~0.6 Hz at rest; sprint
    // wakes a single gait bob at 1.7 Hz. `swaySpeed` scales every
    // frequency for taste (1 = shipped feel, lower = dreamier).
    this._swayT = (this._swayT ?? 0) + dt;
    const TAU = Math.PI * 2;
    const sp = Math.max(0.05, Number(this.swaySpeed) || 1);
    const n = (f, ph) => Math.sin(this._swayT * f * sp * TAU + ph);
    const amp = hh * ((Number(this.swayIdle) || 0.15)
      + Math.pow(e, 1.3) * ((Number(this.swaySprint) || 1.6) - (Number(this.swayIdle) || 0.15)));
    const swayP = ((n(0.11, 0) + n(0.137, 2.1)) * 0.34
      + (n(0.53, 1.1) + n(0.61, 4.4)) * 0.115
      + e * n(1.7, 0.7) * 0.3) * amp;
    const swayY = ((n(0.093, 3.1) + n(0.127, 5.6)) * 0.34
      + (n(0.47, 4.2) + n(0.59, 0.9)) * 0.115
      + e * n(1.7, 3.9) * 0.3) * amp;
    const swayR = ((n(0.083, 1.9) + n(0.107, 0.6)) * 0.34
      + n(0.43, 0.4) * 0.2) * amp * 0.5;

    // YXZ euler that looks from here at the look point (see render3d.setView):
    // yaw about Y first, then pitch about the camera's own X â€” sway rides
    // the OUTPUT fields only; _yaw/_pitch stay the clean input truth.
    this.rotationY = this._yaw + swayY;
    this.rotationX = -this._pitch + swayP;
    this.rotation = swayR;
    // the sprint lens: a small FOV widening, eased by the same energy
    const fovBase = Number(this.fovBase) || 0;
    if (fovBase > 0) this.fov = fovBase + e * (Number(this.fovSprintAdd) || 4);
  }
}

AE1ThirdPersonCamera.agsDef = {
  name: 'ThirdPersonCamera',
  extends: null,
  runInfo: { _camBegin: ['onLoad'], _camTick: ['onTick'] },
};

/**
 * `distance`/`lookHeight` shape the orbit (`lookHeight`, NOT `height` â€” that is
 * a base schema field, and a dat key must never shadow one, invariant 17);
 * `minPitch`/`maxPitch` stop it flipping under the floor or over the top.
 */
AE1ThirdPersonCamera.agsDat = {
  distance: 3.5,
  lookHeight: 1.6,
  minPitch: -60,
  maxPitch: 75,
  // Â§18.43 lock-on framing: how fast the camera swings onto the target
  // (deg/s) and the pitch it settles to while locked.
  lockYawSpeed: 240,
  lockPitch: 16,
  // §click-to-move: arrow-key camera rotation rate (deg/s), cursor-mode only.
  keyLookSpeed: 120,
  // §the reference MMO render: element-declared clip range + distance fog (applied in
  // render3d.setView). Defaults are inert (0 clip = keep frameCamera's; fog
  // off) so existing cameras are unchanged. A tight farPlane fixes z-fighting;
  // fog fades the world into the sky like 2004 RS.
  nearPlane: 0,
  farPlane: 0,
  fog: false,
  fogColor: '#aeb9c2',
  fogStart: 0.5,   // fraction of farPlane where fog begins
  fogSky: true,    // paint the background the fog colour (no hard horizon)
  // §scroll-zoom: wheel dollies the orbit distance in/out (opt-in).
  wheelZoom: false,
  zoomMin: 2,
  zoomMax: 24,
  zoomStep: 1.5,
  // §third-person collision: OPT-IN boom pull-in when a wall blocks the view. Off
  // by default — pulling the camera in reads as "stuck" against buildings; the
  // preferred fix is fading the OCCLUDER (per-element `nearFade true`), not moving
  // the camera. Left available for projects that do want a hard pull-in.
  camCollide: false,
  camMargin: 0.3,
  camMinDist: 0.6,
  // Â§18.47 the Fox camera (MGSV feel). `handheld` is the master sway scale
  // â€” MGSV's own Camera Shake toggle; 0 = the old rigid camera exactly.
  handheld: 1,
  swayIdle: 0.15, // deg â€” barely-alive breathing at rest
  swaySprint: 1.6, // deg â€” the documentary chase at full tilt
  // Â§18.61: every sway frequency rides this â€” 1 = shipped feel, lower =
  // dreamier drift, higher = back toward the old nervousness.
  swaySpeed: 1,
  // Â§18.61: seconds of "mass" on the orbit â€” input accelerates the look
  // in over this constant and glides out over the same. 0 = raw MGSV.
  lookSmooth: 0.07,
  chaseLag: 0.08, // s â€” position damping at rest (composed)
  // steady-state drag â‰ˆ speed Ã— lag: the player character sprints ~12 m/s (Snake ~6), so the
  // MGSV research value of 0.3 s trailed 3.6 m â€” halved for the same LOOK
  chaseLagSprint: 0.15, // s â€” the character leads ~1.8 m at full sprint
  shoulder: 0.25, // m â€” off-center framing along the camera's right
  runLower: 0.22, // m â€” the pivot rides lower at speed
  distSprintAdd: 0.4, // m â€” the camera hangs further back at speed
  fovBase: 48, // deg vertical (the 28 mm lens); 0 = renderer default
  fovSprintAdd: 4, // the subtle sprint widening â€” speed reads from lag+sway
};

defineDatAccessors(AE1ThirdPersonCamera);

/* ------------------------------------------------------------------------- */

export class AE1ThirdPersonCharacter extends AE1Model {
  _vy = 0; // vertical velocity, m/s
  _grounded = true;
  _floorY = 0; // spawn height: the world's floor of last resort
  _inert = false; // true on the second character in a scene
  _state = null; // 'idle' | 'move' | 'turn' | 'interact' | 'air' | strafes/backs
  _inv = []; // picked-up Hitbox elements, in pickup order (Â§18.11)
  _invIndex = -1; // which inventory slot is EQUIPPED (-1 = hands empty)
  _lockTarget = null; // the locked-on enemy (Â§18.43), or null
  _lockMark = null; // the spawned LockMarker element while locked

  get grounded() {
    return this._grounded;
  }

  /** The inventory: the picked-up elements, equipped one first-class. */
  get inventory() {
    return this._inv;
  }

  /** The element wielded right now, or null. */
  get equipped() {
    return this._inv[this._invIndex] ?? null;
  }

  /* -- items (Â§18.11) ----------------------------------------------------- */

  /** Pick a Hitbox up: hide it in the world, add to the inventory, and (the
   *  first item, or an empty hand) EQUIP it. Dispatches onPickup to the item.
   *
   *  `(pickupAs "OtherElementName")` on the touched item REDIRECTS the whole
   *  pickup to that other element first (Â§ the type-3 fist's pair): a
   *  companion piece that is never itself the inventory item â€” walking up to
   *  either half of a pair and pressing E picks up the SAME real item either
   *  way, wherever its own physics happened to leave it. */
  pickUp(item) {
    if (item?.pickupAs) {
      const real = this.find(String(item.pickupAs));
      if (real) item = real;
    }
    if (!item || this._inv.includes(item)) return false;
    // No DUPLICATE TYPES (Â§18.32): one "Bazooka" in the pockets is every
    // bazooka â€” a scene's own copy of a carried item stays on its rack.
    // Stackables arrive with the inventory GUI; until then `(stackable true)`
    // on the item opts out of the guard.
    if (
      !(item.stackable === true || item.stackable === 'true') &&
      this._inv.some((i) => i.name === item.name)
    ) {
      return false;
    }
    item.visible = false;
    this._inv.push(item);
    this.world?.inventory?.add?.({ id: item.name, name: item.name });
    this.world?.loop?.dispatchTo(item, 'onPickup', this);
    if (this._invIndex < 0) this.equipIndex(this._inv.length - 1);
    return true;
  }

  /** Equip inventory slot i â€” WRAPPING in both directions (scrolling back
   *  from slot 0 lands on the last item, never an empty hand; the hand only
   *  empties when the inventory does). The mount component is the renderer's
   *  contract: it parents the item's object to this character's socket bone
   *  (auto-detected right hand unless the item names one). Dispatches
   *  onUnequip/onEquip to the items involved. */
  equipIndex(i) {
    const prev = this.equipped;
    if (prev) {
      prev.setComponent('model', 'mount', null);
      prev.visible = false;
      this.world?.loop?.dispatchTo(prev, 'onUnequip', this);
    }
    if (!this._inv.length) {
      this._invIndex = -1;
      return;
    }
    this._invIndex = ((i % this._inv.length) + this._inv.length) % this._inv.length;
    const item = this._inv[this._invIndex];
    item.visible = true;
    // A snapshot of the grip numbers â€” but the renderer prefers the item's
    // LIVE dat while mounted (mountX/Y/Z, mountOffsetX/Y/Z), so tuning in
    // Properties during play moves the grip in real time.
    item.setComponent('model', 'mount', {
      host: this.name,
      bone: this.socketBone(item.socket ?? 'rightHand'),
      // The item-authored grip node (a Blender Empty parented into the glb):
      // when present, the renderer aligns ITS frame to the bone â€” authored
      // sockets beat hand-tuned offsets (Â§18.14). '' = auto-detect.
      grip: String(item.gripNode ?? ''),
      px: Number(item.mountX) || 0,
      py: Number(item.mountY) || 0,
      pz: Number(item.mountZ) || 0,
      rx: Number(item.mountOffsetX) || 0,
      ry: Number(item.mountOffsetY) || 0,
      rz: Number(item.mountOffsetZ) || 0,
      scale: Number(item.mountScale) || 1,
    });
    this.world?.loop?.dispatchTo(item, 'onEquip', this);
  }

  /**
   * MOUNT A SECOND MESH ON ANOTHER SOCKET â€” the PAIR-WEAPON path (Â§18.14).
   * `equipIndex` mounts the equipped item to its own socket and that is the
   * whole story for a lance or a bazooka: one mesh, one hand. The type-3
   * fist is two meshes in two hands, so its script mounts the off-hand arm
   * itself â€” and Angel Script has no object literal to write a mount
   * component by hand (every other script passes strings or arrays). This is
   * that missing verb, using the SAME contract equipIndex writes, so the
   * renderer's live-dat grip tuning works identically on both arms:
   *
   *   actor.mountExtra(this.find(this.fistPair), "leftHand")
   *   actor.unmountExtra(this.find(this.fistPair))
   *
   * The element is NOT inventory: it is scenery the character wears, shown
   * and hidden with the mount.
   */
  mountExtra(item, socketName) {
    if (!item) return false;
    item.visible = true;
    item.setComponent('model', 'mount', {
      host: this.name,
      bone: this.socketBone(socketName ?? 'leftHand'),
      grip: String(item.gripNode ?? ''),
      px: Number(item.mountX) || 0,
      py: Number(item.mountY) || 0,
      pz: Number(item.mountZ) || 0,
      rx: Number(item.mountOffsetX) || 0,
      ry: Number(item.mountOffsetY) || 0,
      rz: Number(item.mountOffsetZ) || 0,
      scale: Number(item.mountScale) || 1,
    });
    return true;
  }

  /** Take an extra-mounted mesh off: home to its glb parent, out of sight. */
  unmountExtra(item) {
    if (!item) return false;
    item.setComponent('model', 'mount', null);
    item.visible = false;
    return true;
  }

  /** Drop what is wielded: out of the hand, out of the inventory, back into
   *  the world just in front of the character. Dispatches onUnequip (before
   *  the splice below â€” after it, `this.equipped` no longer names this item,
   *  so a dispatch built from `prev` inside the equipIndex() call further
   *  down would either miss it or land on the wrong element) and onDrop.
   *  A PAIR weapon's off-hand cleanup (Type3Fist's `stowed()`, which calls
   *  `unmountExtra`) lives on onUnequip â€” without this the left arm stayed
   *  mounted on her hand after the right one hit the ground (Austin's
   *  "a bracer has fallen off"). */
  dropEquipped() {
    const item = this.equipped;
    if (!item) return false;
    this._inv.splice(this._invIndex, 1);
    this.world?.inventory?.remove?.(item.name);
    item.setComponent('model', 'mount', null);
    this.world?.loop?.dispatchTo(item, 'onUnequip', this);
    const h = (this._heading ?? 0) * DEG;
    item.x = (this.x ?? 0) + Math.sin(h) * 0.8;
    item.z = (this.z ?? 0) + Math.cos(h) * 0.8;
    item.y = this.y ?? 0;
    item.visible = true;
    this.world?.loop?.dispatchTo(item, 'onDrop', this);
    // The hand takes the next slot if one exists, else goes empty.
    this.equipIndex(this._inv.length ? Math.min(this._invIndex, this._inv.length - 1) : -1);
    return true;
  }

  /** The bone name a socket resolves to. `(sockets (rightHand "boneName"))`
   *  in dat overrides; empty means the renderer auto-detects a right hand. */
  socketBone(name) {
    let list = Array.isArray(this.sockets) ? this.sockets : [];
    if (list.length && typeof list[0] === 'string' && !Array.isArray(list[1])) list = [list];
    const entry = list.find((s) => Array.isArray(s) && String(s[0]) === String(name));
    return entry ? String(entry[1] ?? '') : '';
  }

  /** The first pickable Hitbox whose volume the character stands in. */
  _pickTarget() {
    for (const e of this.world?.scene?.all() ?? []) {
      if (!(e instanceof AE1Hitbox) || this._inv.includes(e)) continue;
      if (e.pickable === false || e.pickable === 'false') continue;
      if (e.visible === false) continue;
      if (e.containsPoint(this.x ?? 0, this.y ?? 0, this.z ?? 0)) return e;
    }
    return null;
  }

  /** The first NON-pickable Hitbox the character stands in â€” something to
   *  talk to or poke, not to pocket. E dispatches onInteract to it (Â§18.12). */
  _touchTarget() {
    for (const e of this.world?.scene?.all() ?? []) {
      if (!(e instanceof AE1Hitbox) || this._inv.includes(e)) continue;
      if (!(e.pickable === false || e.pickable === 'false')) continue;
      if (e.visible === false) continue;
      if (e.containsPoint(this.x ?? 0, this.y ?? 0, this.z ?? 0)) return e;
    }
    return null;
  }

  /**
   * Mid-swing, once: when the attack clip crosses the weapon's
   * `(projectileAt â€¦)` fraction, a fresh round SPAWNS from the weapon's
   * `(projectile "â€¦")` template and launches along the facing (Â§18.15).
   */
  _projectileCheck() {
    const w = this.equipped;
    if (!w || this._projFired) return;
    const pname = w.projectile && String(w.projectile);
    if (!pname) return;
    const ct = this.world?.env3d?.clipTime?.(this);
    if (!ct || !ct.d || ct.t / ct.d < (Number(w.projectileAt) || 0.5)) return;
    this._projFired = true;

    // The scene's own template first; else one TRAVELLING with the carried
    // weapon (Â§18.38) â€” new scenes need no hand-copied ammunition.
    const tpl =
      this.world?.scene?.all().find((e) => e.name === pname) ??
      this.world?.carriedAux?.find((e) => e.name === pname);
    if (!tpl?.launch) {
      console.warn(`[ags] "${w.name}" names projectile "${pname}", which is not a Projectile element.`);
      return;
    }
    // A fresh ROUND from the template's serialized form â€” same class, same
    // dat, its own id. scene.add() â†’ the world rescans the schedule
    // (invariant 13) and the renderer clones it a mesh (Â§18.15).
    const data = tpl.serialize();
    delete data.id;
    data.name = `${pname} round`;
    const round = new tpl.constructor(data);
    round._spawned = true;
    this.world.scene.add(round);
    // FROM the muzzle, TOWARD the camera's focal point (Â§18.16): the weapon's
    // authored muzzle node is the launch origin, and the flight converges on
    // whatever sits at the exact center of the view â€” the third-person
    // shooter triangle (camera â†’ focal â† muzzle). A weapon without a muzzle
    // node falls back to chest height; no focal falls back to the heading.
    const h = (this._heading ?? 0) * DEG;
    const hdir = { x: Math.sin(h), y: 0, z: Math.cos(h) };
    const from = this.world?.env3d?.nodePos?.(w, w.muzzleNode) ?? {
      x: (this.x ?? 0) + hdir.x * 0.9,
      y: (this.y ?? 0) + 1.35,
      z: (this.z ?? 0) + hdir.z * 0.9,
    };
    let focal = this._aimFocal(Number(this.aimDist) || 60); // lock-aware (Â§18.43)
    // The Â§18.36 rule applies at the SPAWN too: a focal nearer than the
    // character (a tree beside the lens) sat BEHIND the muzzle, so
    // focal âˆ’ muzzle pointed backwards and the round flew off past the
    // camera â€” "the bazooka didn't fire". Push it out along the camera ray.
    if (focal) {
      const rx = focal.x - focal.ox, ry = focal.y - focal.oy, rz = focal.z - focal.oz;
      const fd = Math.hypot(rx, ry, rz) || 1;
      const minD = Math.hypot((this.x ?? 0) - focal.ox, (this.z ?? 0) - focal.oz) + 3;
      if (fd < minD) {
        const s = minD / fd;
        focal = { ...focal, x: focal.ox + rx * s, y: focal.oy + ry * s, z: focal.oz + rz * s };
      }
    }
    let dir = hdir;
    if (focal) {
      const dx = focal.x - from.x, dy = focal.y - from.y, dz = focal.z - from.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-3) dir = { x: dx / len, y: dy / len, z: dz / len };
    }
    round.launch(from, dir, this);
    // Effects fire WITH the weapon (Â§18.22): every non-looping Particles
    // element HOSTED on this weapon bursts at the spawn moment â€” a muzzle
    // flash and a breech smoke puff need zero script code.
    for (const e of this.world?.scene?.all() ?? []) {
      if (typeof e.burst !== 'function') continue;
      const bag = e.components?.fx;
      if (String(bag?.host ?? e.fxHost ?? '') !== String(w.name ?? '')) continue;
      if (bag ? bag.loop === false : e.fxLoop === false || e.fxLoop === 'false') e.burst();
    }
  }

  /** One frame of the swing: the wielded weapon's volume against every
   *  NPC's. First overlap deals `(damage â€¦)`, once per swing (Â§18.12). */
  _attackSweep() {
    if (this._attackHit) return;
    const w = this.equipped;
    if (!w?.bounds) return;
    // A weapon that FIRES hurts through its round, not its barrel â€” no
    // point-blank double-dip of sweep damage plus missile damage (Â§18.15).
    if (w.projectile) return;
    for (const e of this.world?.scene?.all() ?? []) {
      if (e === w || e === this || typeof e.takeDamage !== 'function') continue;
      if (e.visible === false || e._dead) continue;
      if (w.intersects(e, 0.1)) {
        this._attackHit = true;
        const wasDead = !!e._dead;
        e.takeDamage(Number(w.damage) || 0, this);
        // -- IMPACT EMPHASIS (Â§18.41) â€” fired from the one seam every melee
        // hit passes through. A landed blow gets the fighting-game hit stop
        // + a light rumble; the FATAL blow gets the kill slow-mo + the heavy
        // thud. The kill effect replaces (not stacks) the hit stop: _pushFx
        // combines by minimum, and the pad swaps to the newer pulse.
        const killed = !wasDead && !!e._dead;
        const loop = this.world?.loop;
        const pad = this.world?.input3d;
        if (killed) {
          loop?.slowMo?.(0.7, 0.12, 0.45);
          pad?.rumble?.(1.0, 0.6, 320);
        } else {
          const heavy = (Number(w.damage) || 0) >= 20;
          loop?.hitStop?.(heavy ? 0.13 : 0.08, 0.05);
          pad?.rumble?.(heavy ? 0.7 : 0.45, 0.3, heavy ? 140 : 90);
        }
        return;
      }
    }
  }

  /**
   * The player CAN BE HURT now (Â§18.28): `(health 100)` dat, and monsters
   * (or anything) call `takeDamage`. Dispatches `onHit (attacker, amount)`
   * like the NPC's. At zero â€” deliberately â€” NOTHING happens yet: death,
   * respawn, and game-over are a design conversation, not a default.
   */
  takeDamage(amount, from = null) {
    const n = Math.max(0, Number(amount) || 0);
    this.health = (Number(this.health) || 0) - n;
    this.world?.loop?.dispatchTo(this, 'onHit', from, n);
  }

  /* -- lock-on (Â§18.43) ---------------------------------------------------- */

  /** Toggle + upkeep, called by BOTH character systems' ticks. The press
   *  edge flips the lock; upkeep drops it when the target dies, hides, or
   *  breaks the leash â€” with the marker following in the same frame. */
  _lockTick(input, ctl) {
    if (ctl?.lockOn && input?.pressed?.(ctl.lockOn)) {
      if (this._lockTarget) this._lockRelease();
      else this._lockAcquire();
    }
    const t = this._lockTarget;
    if (
      t &&
      (t._dead ||
        t.visible === false ||
        Math.hypot((t.x ?? 0) - (this.x ?? 0), (t.z ?? 0) - (this.z ?? 0)) >
          (Number(this.lockRange) || 40) * 1.25)
    ) {
      this._lockRelease();
    }
  }

  /** The enemy CLOSEST TO THE AIM RAY wins (Austin's spec): the camera â†’
   *  focal ray that the bazooka shoots down. Candidates are the NPC family
   *  (anything with `takeDamage` + `_npcAnimate` â€” no import, the npc module
   *  sits above this one). Score = perpendicular distance to the ray plus a
   *  light range tax, so of two enemies near the crosshair the nearer wins. */
  _lockAcquire() {
    const scn = this.world?.scene;
    const cam = scn?.all().find((e) => typeof e._camTick === 'function');
    if (!cam) return;
    const yaw = (cam._yaw ?? 0) * DEG;
    const pitch = (cam._pitch ?? 0) * DEG;
    // view forward: from the camera toward its look point (see _camTick)
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = -Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    const range = Number(this.lockRange) || 40;
    let best = null;
    let bestScore = Infinity;
    for (const e of scn.all()) {
      if (e === this || typeof e.takeDamage !== 'function') continue;
      if (typeof e._npcAnimate !== 'function') continue; // the NPC/Enemy family
      if (e._dead || e.visible === false) continue;
      const b = this.world?.env3d?.boundsOf?.(e);
      const cx = b ? (b.min.x + b.max.x) / 2 : (e.x ?? 0);
      const cy = b ? (b.min.y + b.max.y) / 2 : (e.y ?? 0) + 1;
      const cz = b ? (b.min.z + b.max.z) / 2 : (e.z ?? 0);
      const vx = cx - (cam.x ?? 0);
      const vy = cy - (cam.y ?? 0);
      const vz = cz - (cam.z ?? 0);
      const along = vx * fx + vy * fy + vz * fz;
      if (along < 0.5 || along > range) continue; // behind, or past the leash
      const px = vx - fx * along;
      const py = vy - fy * along;
      const pz = vz - fz * along;
      const score = Math.hypot(px, py, pz) + along * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (!best) return;
    this._lockTarget = best;
    this._lockSpawnMark();
  }

  _lockRelease() {
    this._lockTarget = null;
    // the marker STAYS in the scene, hidden by its own tick (no target â†’
    // invisible): destroying and respawning it per toggle cost a renderer
    // rebuild EACH WAY â€” rapid toggling in a nine-tile scene turned into a
    // permanent stutter (Â§18.52's "major frame pause"). One marker element
    // per session, reused forever.
  }

  /** SPAWN the indicator (Â§18.43) â€” a LockMarker element added to the live
   *  scene; game3d notices the element count change and loads its glb. The
   *  media name lives in dat (`lockMarkerMedia`) so the exporter's name scan
   *  inlines the disc into shipped builds. */
  _lockSpawnMark() {
    const scn = this.world?.scene;
    if (!scn) return;
    // HEAL a stale handle (Â§18.52): a toggle storm once left `_lockMark`
    // pointing at a removed element â€” this guard then refused every future
    // spawn and lock-on looked markerless for the rest of the session.
    if (this._lockMark && !scn.all().some((e) => e.id === this._lockMark.id)) {
      this._lockMark = null;
    }
    if (this._lockMark) return;
    const mark = new AE1LockMarker({
      id: 'lockmark-' + Math.random().toString(36).slice(2, 10),
      name: '__LockMark',
      type: 'object',
      visible: false, // its own tick shows it once positioned
      x: this.x ?? 0,
      y: (this.y ?? 0) + 1,
      z: this.z ?? 0,
      components: {
        model: {
          media: String(this.lockMarkerMedia || 'lock_ring.glb'),
          node: String(this.lockMarkerNode || 'lock_ring'),
        },
      },
    });
    scn.add(mark);
    this._lockMark = mark;
    this.world?.loop?.rescan?.();
  }

  /** The aim focal, lock-aware: locked, every aimed system (bazooka spawn
   *  direction, aim-assist pivot, HUD lines) aims at the TARGET's center
   *  instead of the terrain focal â€” the ray still originates at the camera. */
  _aimFocal(dist) {
    const base = this.world?.env3d?.aimPoint?.(this, dist);
    const t = this._lockTarget;
    if (!t || t._dead || t.visible === false) return base;
    const b = this.world?.env3d?.boundsOf?.(t);
    const cx = b ? (b.min.x + b.max.x) / 2 : (t.x ?? 0);
    const cy = b ? (b.min.y + b.max.y) / 2 : (t.y ?? 0) + 1;
    const cz = b ? (b.min.z + b.max.z) / 2 : (t.z ?? 0);
    if (base) return { ...base, x: cx, y: cy, z: cz };
    const cam = this.world?.scene?.all().find((e) => typeof e._camTick === 'function');
    return {
      x: cx, y: cy, z: cz,
      ox: cam?.x ?? this.x ?? 0,
      oy: cam?.y ?? (this.y ?? 0) + 1.5,
      oz: cam?.z ?? this.z ?? 0,
    };
  }

  /** The current animation state. */
  get state() {
    return this._state;
  }

  /**
   * The DEFAULT state machine: each state plays the clip its dat names, and a
   * state with no clip rests on the BIND pose (the T-pose) â€” so a character
   * with only an idle animation idles when still and T-poses otherwise,
   * exactly the graceful-degradation shape as everywhere else. Called on every
   * state CHANGE, never per frame.
   *
   * States â†’ dat keys: idle, move (walking), turn (the 180 reversal, played
   * ONCE â€” and REVERSED, timeScale âˆ’1, on every other reversal, so turning
   * back mirrors turning away), strafeLeft/strafeRight (pure lateral),
   * backLeft/backRight (diagonal backward), air (jumping/falling).
   *
   * This is script territory (DESIGN.md Â§18.7): override `animate` in an Angel
   * Script to run a richer machine â€” the engine only tells you WHEN.
   */
  animate(state, extra = null) {
    const clip = {
      idle: this.idle,
      move: this.move,
      turn: this.turn,
      air: this.air,
      interact: this.interact,
      // The WIELDED weapon's own attack clip wins â€” a bazooka fires, a lance
      // stabs, and the character's (attack â€¦) is the fallback (Â§18.14).
      attack: (this.equipped && String(this.equipped.attack || '')) || this.attack,
      strafeLeft: this.strafeLeft,
      strafeRight: this.strafeRight,
      backLeft: this.backLeft,
      backRight: this.backRight,
    }[state];
    if (!clip) return this.bindPose();
    const o = this.animOptsFor(state);
    if (state === 'interact' || state === 'attack') o.loop = false; // one-shots by definition
    if (state === 'turn') {
      // The 180 is always a one-shot and its direction alternates. FORWARD
      // playback enters over the `turnBlend` crossfade (its start pose is
      // un-turned â€” nothing to fight). REVERSED playback enters on a HARD
      // CUT: its start pose sits 180Â° away, and a quaternion blend at 180Â°
      // picks an arbitrary hemisphere â€” it stacked with the heading swap
      // into a full spin. The exit hand-off ramps for both (see _tpcClipEnd).
      o.loop = false;
      o.speed = (o.speed ?? 1) * (this._turnDir || 1);
      o.fade = this._turnDir < 0 ? 0 : Math.max(0.01, Number(this.turnBlend) || 0.25);
    }
    this.play(clip, extra ? { ...o, ...extra } : o);
  }

  /**
   * Per-state playback tweaks, from `(animOpts â€¦)` dat:
   *
   *   (animOpts
   *     (air (loop false) (startFrame 12) (fps 30))
   *     (move (speed 1.2)))
   *
   * Options: `loop` (default true), `speed`, `start` (seconds into the clip),
   * `startFrame` + `fps` (the same thing in frames; fps defaults to 30).
   * Shape-normalised hard: the reader collapses single-item lists at EVERY
   * level, so one state with one option arrives flatter than two with two.
   */
  animOptsFor(state) {
    let list = Array.isArray(this.animOpts) ? this.animOpts : [];
    if (list.length && typeof list[0] === 'string') list = [list]; // one state entry
    const entry = list.find((e) => Array.isArray(e) && String(e[0]) === String(state));
    const o = {};
    if (!entry) return o;
    let pairs = entry.slice(1);
    // one option collapsed flat: ["air", "loop", false] â†’ [["loop", false]]
    if (pairs.length === 2 && typeof pairs[0] === 'string' && !Array.isArray(pairs[0])) pairs = [pairs];
    const raw = {};
    for (const p of pairs) {
      if (Array.isArray(p) && p.length >= 2) raw[String(p[0])] = p[1];
    }
    // dat booleans may arrive as the SYMBOL "false" â€” a truthy string.
    if ('loop' in raw) o.loop = !(raw.loop === false || raw.loop === 'false' || raw.loop === 0);
    if ('speed' in raw) o.speed = Number(raw.speed) || 1;
    if ('start' in raw) o.start = Math.max(0, Number(raw.start) || 0);
    else if ('startFrame' in raw) o.start = Math.max(0, Number(raw.startFrame) || 0) / (Number(raw.fps) || 30);
    // TRIM THE TAIL (Â§18.35): `end` (seconds) / `endFrame` â€” the clip counts
    // as finished (or wraps, when looping) at this point. Mixamo clips carry
    // long settles; cutting them is most of "snappy".
    if ('end' in raw) o.end = Math.max(0, Number(raw.end) || 0);
    else if ('endFrame' in raw) o.end = Math.max(0, Number(raw.endFrame) || 0) / (Number(raw.fps) || 30);
    if ('fade' in raw) o.fade = Math.max(0, Number(raw.fade) || 0);
    return o;
  }

  /** The `(footsteps (floor "â€¦") (grass "â€¦"))` map: ground TYPE â†’ audio file,
   *  reader-collapse normalised (one pair arrives flat â€” the animations trap). */
  _footstepFor(type) {
    let list = Array.isArray(this.footsteps) ? this.footsteps : [];
    if (list.length && typeof list[0] === 'string') list = [list];
    for (const p of list) {
      if (Array.isArray(p) && p.length >= 2 && String(p[0]) === type) return String(p[1]);
    }
    return '';
  }

  /**
   * FOOTSTEPS by surface (Â§18.20). Walking â€” grounded, in a locomotion state
   * (never air, attack, interact, or idle) â€” loops the audio mapped to the
   * ground's `(groundType â€¦)` dat (read off the element the ground ray hit).
   * The loop is TOUCHED ONLY ON CHANGE: same surface, same state â†’ the same
   * audio element keeps playing, seamless; a surface change swaps the source;
   * anything else stops it. Untagged/unmapped ground walks silently.
   */
  _footTick() {
    const moving =
      this._grounded &&
      (this._state === 'move' ||
        this._state === 'turn' ||
        this._state === 'strafeLeft' ||
        this._state === 'strafeRight' ||
        this._state === 'backLeft' ||
        this._state === 'backRight');
    const type = moving ? String(this._groundEl?.groundType ?? '') : '';
    const file = type ? this._footstepFor(type) : '';
    if (!moving || !file) {
      if (this._stepAudio) {
        this._stepAudio.stopLoop?.();
        this._stepAudio = null;
        this._stepType = null;
      }
      return;
    }
    if (!this._stepAudio || this._stepType !== type || !this._stepAudio.src) {
      this._stepAudio?.stopLoop?.();
      this._stepType = type;
      this._stepAudio = this.world?.loopSound?.(file, {
        volume: Math.max(0, Math.min(1, Number(this.footstepVolume ?? 0.8))),
      });
    }
  }

  /** Write the current heading through the quat kit onto all three euler
   *  fields â€” facing is a world yaw composed onto the rest orientation. */
  _applyHeading() {
    const e = qToEulerXYZ(qMul(qYaw((this._heading ?? 0) - this._h0), this._qrest));
    this.rotationX = e.x;
    this.rotationY = e.y;
    this.rotation = e.z;
  }

  /** Advance the turn's heading ramp: a lerp timed to the SAME window as the
   *  mixer crossfade, so the clip's blending root yaw and the moving heading
   *  cancel (a blend of pure yaw is linear in angle â€” the cancellation is
   *  exact, not approximate). Outside a ramp, hold per playback direction. */
  _tickTurnRamp(dt) {
    const r = this._turnRamp;
    if (!r) {
      this._heading = (this._turnDir >= 0 ? this._turnFrom : this._turnTo) ?? this._heading;
      return;
    }
    const T = Math.max(0.01, Number(this.turnBlend) || 0.25);
    r.t = Math.min(T, r.t + dt);
    const d = ((r.to - r.from + 540) % 360) - 180; // shortest path (ties go negative)
    this._heading = r.from + d * (r.t / T);
    if (r.t >= T) {
      this._heading = r.to;
      this._turnRamp = null;
    }
  }

  /** The renderer's mixer says a one-shot ended. A finished 180 turn hands
   *  over to 'move' â€” the walk the turn was FOR â€” through the EXIT ramp: the
   *  walk fades in over `turnBlend` while the heading lerps home, cancelling
   *  the turn clip's fading root yaw. Smooth legs, stable facing. */
  _tpcClipEnd() {
    // A finished one-shot (interact, attack) hands back to idle; next tick the
    // machine recomputes (keys still held pick movement straight back up).
    if (this._state === 'interact' || this._state === 'attack') {
      // The reach dies with the grab (the renderer ramps it out smoothly).
      if (this.components?.model?.reach) this.setComponent('model', 'reach', null);
      this._state = 'idle';
      this.animate('idle');
      return;
    }
    if (this._state !== 'turn') return;
    const blend = Math.max(0.01, Number(this.turnBlend) || 0.25);
    this._turnPhase = 'exit';
    // Forward playback ends holding the origin â€” ramp it home over the fade.
    // Reversed ends already AT the target (its ramp ran at entry): no ramp,
    // hand over immediately.
    const residual = Math.abs((((this._turnTo ?? 0) - (this._heading ?? 0) + 540) % 360) - 180);
    this._turnRamp =
      residual > 1 ? { from: this._heading ?? 0, to: this._turnTo ?? 0, t: 0 } : null;
    this.animate('move', { fade: blend });
    if (!this._turnRamp) {
      this._heading = this._turnTo ?? this._heading;
      this._applyHeading();
      this._state = 'move';
      this._turnPhase = null;
    }
  }

  _tpcBegin() {
    this._floorY = this.y ?? 0;

    // The rest orientation, kept whole. Facing composes a world yaw ON TOP of
    // it â€” writing rotationY alone would spin a baked-rotation armature about
    // a tilted axis (the upside-down-under-the-floor bug; see the quat kit).
    this._qrest = qFromEulerXYZ(this.rotationX ?? 0, this.rotationY ?? 0, this.rotation ?? 0);
    this._h0 = qTwistYDeg(this._qrest); // the yaw already inside the rest pose
    this._heading = this._h0;

    // ONE CONTROLLED third-person character per scene. The FIRST
    // non-autopilot one wins; a second goes inert and says so â€” silence
    // here would look like a broken controller. INERT MEANS INVISIBLE TOO
    // (Austin: "the character is duplicated and she is in T-pose in the
    // same position"): an unticked skeleton is a T-pose ghost.
    // Â§18.82 amends the doctrine: a character on (autopilot true) IS
    // driven â€” its wander poses the skeleton â€” so parked playable
    // characters (the companion character) are always allowed alongside the player. The old
    // blanket rule silently vanished him at load.
    const isAuto = (e) => e.autopilot === true || e.autopilot === 'true';
    if (!isAuto(this)) {
      const drivers = (this.world?.scene?.all() ?? [])
        .filter((e) => e instanceof AE1ThirdPersonCharacter && !isAuto(e));
      if (drivers.length > 1 && drivers[0] !== this) {
        this._inert = true;
        this.visible = false;
        console.warn(
          `[ags] Two CONTROLLED third-person characters in one scene: "${drivers[0].name}" is active, "${this.name}" is inert.`,
        );
      }
    }
  }

  _tpcTick(dt) {
    if (this._inert) return;
    const input = this.world?.input3d;
    if (!input) return;

    const ctl = AE1Controller.mappingsIn(this.world);
    const cam = cameraIn(this.world); // §18.87 cached

    this._lockTick(input, ctl); // Â§18.43: toggle + upkeep, shared with the MM path

    // -- interact & attack: UNINTERRUPTIBLE one-shots ---------------------- //
    // While one plays, it owns the body: no movement, no jump, no actions, no
    // state changes â€” the clip's onFinished is the only way out. Grounded
    // only, never mid-turn, and repeat presses are simply ignored. The attack
    // additionally SWEEPS: each frame of the swing, the weapon's volume is
    // tested against every NPC's â€” first overlap deals the weapon's damage,
    // once per swing (Â§18.12).
    // -- the aim triangulation, drawn live (Â§18.16) ------------------------ //
    // `(drawAim true)` AND a projectile weapon in hand: a warm line from the
    // camera down to its FOCAL point (the exact center of the view, out
    // `aimDist` or to the first thing hit), then onward to the muzzle. This
    // is the triangle a fired round flies. Unarmed draws NOTHING â€” the lines
    // are a debug tool for aimed weapons, and their per-tick focal raycast is
    // work nobody should pay while carrying a lance (or nothing at all).
    const wield = this.equipped;
    // A weapon is AIMED if it fires rounds OR declares a barrel (muzzleNode)
    // â€” the portal gun aims like the bazooka but spawns no template round.
    // A lance declares neither and stays free of the per-tick focal raycast.
    const armed = !!wield?.projectile || !!wield?.muzzleNode;
    // AIM ASSIST (Â§18.16): while a projectile weapon is wielded, hand it the
    // focal point every tick â€” the renderer pivots the mesh about the grip so
    // the barrel tracks where the round will fly. One raycast serves both the
    // assist and the debug lines.
    const assist = armed && !(wield.aimAssist === false || wield.aimAssist === 'false');
    const wantLines = armed && (this.drawAim === true || this.drawAim === 'true');
    let focal = assist || wantLines
      ? this._aimFocal(Number(this.aimDist) || 60) // lock-aware (Â§18.43)
      : null;
    // A focal NEARER than the character is not an aim target (Â§18.36): the
    // camera looking AT her puts the view-centre hit on the ground just past
    // her feet, and the assist dutifully bent the barrel at her knees (and
    // the trigger snap spun her at whatever stood beside the lens). Push a
    // too-near focal OUT along the ray â€” aim through the clutter; a round
    // that hits the near thing anyway still hits it (its own cast decides).
    if (focal) {
      const rx = focal.x - focal.ox;
      const ry = focal.y - focal.oy;
      const rz = focal.z - focal.oz;
      const fd = Math.hypot(rx, ry, rz) || 1;
      const pd = Math.hypot((this.x ?? 0) - focal.ox, (this.z ?? 0) - focal.oz);
      const minD = pd + 3;
      if (fd < minD) {
        const s = minD / fd;
        focal = { ...focal, x: focal.ox + rx * s, y: focal.oy + ry * s, z: focal.oz + rz * s };
      }
    }
    if (assist && focal) {
      // §18.87: a persistent LIVE array — a fresh [x,y,z] every frame defeated
      // setComponent's identity early-out (3 allocs + a notify per frame,
      // forever). Values mutate in place; the renderer reads them fresh.
      let aim = wield.components?.model?.aimAt;
      if (!Array.isArray(aim) || !aim._ae1Live) {
        aim = [focal.x, focal.y, focal.z];
        aim._ae1Live = true;
        wield.setComponent('model', 'aimAt', aim);
      } else { aim[0] = focal.x; aim[1] = focal.y; aim[2] = focal.z; }
    }
    else if (wield?.components?.model?.aimAt) wield.setComponent('model', 'aimAt', null);
    if (wantLines && focal) {
      // The camera leg starts a touch ABOVE the eye: a line drawn exactly
      // along the view axis projects to a single dot at screen center â€”
      // raising the near end makes the tracer COME DOWN from the top of
      // the view, over the character's head, to the crosshair (Austin's
      // call: the muzzle leg seeks that descending line at the focal).
      const pts = [focal.ox, focal.oy + 0.3, focal.oz, focal.x, focal.y, focal.z];
      const muzzle = this.world?.env3d?.nodePos?.(wield, wield.muzzleNode);
      if (muzzle) pts.push(muzzle.x, muzzle.y, muzzle.z);
      this.setComponent('debug', 'aim', pts);
    } else if (this.components?.debug?.aim) {
      this.setComponent('debug', 'aim', null);
    }

    // Footsteps run every tick, INCLUDING the uninterruptible states below â€”
    // a fired bazooka or an interact must silence the walk loop that frame.
    this._footTick();

    if (this._state === 'attack') {
      this._attackSweep();
      this._projectileCheck();
      return;
    }
    if (this._state === 'interact') return;
    if (this._grounded && this._state !== 'turn' && input.pressed(ctl.interact)) {
      // Shift+E DROPS what is wielded â€” no animation, just let go.
      if (input.down('ShiftLeft') || input.down('ShiftRight')) {
        this.dropEquipped();
        return;
      }
      // Standing in a pickable Hitbox volume? E takes it (Â§18.11). A
      // NON-pickable hitbox (an NPC) instead HEARS the E: onInteract goes to
      // it (Â§18.12). NOTHING in reach? Then NOTHING happens â€” the interact
      // clip is a long, uninterruptible one-shot, and pantomiming a grab at
      // empty air every stray E press held the player hostage (Austin's
      // call: the animation plays only when there is something to grab).
      const target = this._pickTarget();
      const touched = target ? null : this._touchTarget();
      if (target || touched) {
        // FACE what you grab, and let the ARM reach for it (Â§18.24): the
        // renderer's procedural layer biases the playing clip toward this
        // point â€” computed BEFORE pickUp hides the item; reaching toward
        // where it WAS reads perfectly.
        const tgt = target ?? touched;
        const b = tgt.bounds?.();
        const cx = b ? (b.min.x + b.max.x) / 2 : (Number(tgt.x) || 0);
        const cy = b ? (b.min.y + b.max.y) / 2 : (Number(tgt.y) || 0) + 0.5;
        const cz = b ? (b.min.z + b.max.z) / 2 : (Number(tgt.z) || 0);
        if (target) this.pickUp(target);
        else this.world?.loop?.dispatchTo(touched, 'onInteract', this);
        // (this.interact guard: with no clip configured there is no
        // onFinished to ever exit on â€” better no state than a stuck one.)
        if (this.interact) {
          this._heading =
            Math.atan2(cx - (this.x ?? 0), cz - (this.z ?? 0)) / DEG +
            (Number(this.faceOffset) || 0);
          this._applyHeading();
          this.setComponent('model', 'reach', [cx, cy, cz]);
          this._state = 'interact';
          this.animate('interact');
          this.world?.loop?.dispatchTo(this, 'onInteract', target ?? null);
          return;
        }
      }
    }

    // -- the scroll wheel (or dpad up/down) cycles the inventory ----------- //
    const wheel = (input.consumeWheel?.() ?? 0)
      + (input.pressed('PadDown') ? 1 : 0) - (input.pressed('PadUp') ? 1 : 0);
    if (wheel && this._inv.length > 1) this.equipIndex(this._invIndex + wheel);

    // -- move, relative to where the CAMERA looks ------------------------- //
    // Keys are digital Â±1; the pad's LEFT STICK adds its deflection when the
    // Controller's (gamepad â€¦) toggle is on. This kit's speed is a constant,
    // so only the DIRECTION matters here â€” the normalize below keeps it true.
    input.gamepadEnabled = gamepadOn(ctl);
    let axF = (input.down(ctl.forward) ? 1 : 0) - (input.down(ctl.back) ? 1 : 0);
    let axR = (input.down(ctl.right) ? 1 : 0) - (input.down(ctl.left) ? 1 : 0);
    if (input.gamepadEnabled && input.stick) {
      const s = input.stick();
      axF += s.y;
      axR += s.x;
    }

    // The desired travel vector, camera-relative â€” then which LOCOMOTION it
    // is, classified by the movement's angle RELATIVE TO THE FACING, never by
    // which keys are down. A directional clip only reads correctly against
    // the body: facing the camera, screen-left (A) is her body-RIGHT, so A
    // must play the strafe-RIGHT clip, and S+A is a forward diagonal (walk).
    //   rel â‰ˆ 0 (Â±67.5Â°)      â†’ 'move' (forward + forward diagonals)
    //   rel â‰ˆ Â±180 (>157.5Â°)  â†’ 'move' via the 180 REVERSAL ('turn' first)
    //   rel â‰ˆ +90 / âˆ’90       â†’ 'strafeLeft' / 'strafeRight' â€” heading holds
    //   rel â‰ˆ +135 / âˆ’135     â†’ 'backLeft' / 'backRight'     â€” heading holds
    let mx = 0;
    let mz = 0;
    let wanted = 'idle';
    let rel = 0; // travel direction minus facing, signed; +90 = body-left
    if (axF || axR) {
      const yaw = (cam?._yaw ?? 0) * DEG;
      // Camera sits at +yaw offset; its view forward is the opposite direction.
      const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: -fwd.z, z: fwd.x };
      mx = fwd.x * axF + right.x * axR;
      mz = fwd.z * axF + right.z * axR;
      const len = Math.hypot(mx, mz) || 1; // diagonals are not faster
      mx /= len;
      mz /= len;
    }

    const travelHeading = Math.atan2(mx, mz) / DEG + (Number(this.faceOffset) || 0);
    if (axF || axR) {
      rel = ((travelHeading - (this._heading ?? 0) + 540) % 360) - 180;
      const a = Math.abs(rel);
      if (a < 67.5 || a > 157.5) wanted = 'move'; // forward-ish, or reversal (turn below)
      else if (a > 112.5) wanted = rel > 0 ? 'backLeft' : 'backRight';
      else wanted = rel > 0 ? 'strafeLeft' : 'strafeRight';
    }

    // A reversal: travel roughly opposite the current facing. Turn first,
    // walk after. The clip plays forward on one reversal and REVERSED on the
    // next (`_turnDir` alternates), so turning back mirrors turning away.
    // GROUNDED ONLY: a mid-air reversal must not interrupt the jump clip.
    if (wanted === 'move' && this._grounded && this._state !== 'turn' && this.turn) {
      const away = Math.abs(rel);
      if (away > 135) {
        // ALWAYS FORWARD (Â§18.37): the clip used to alternate direction so
        // turning back mirrored turning away â€” but REVERSED playback demanded
        // a hard-cut entry (a 180Â° pose blend picks its hemisphere at
        // random), and that cut read as "she JUMPED to face forward, then
        // turned". Every turn now plays forward and enters over the
        // `turnBlend` crossfade â€” smooth both ways; the mirror was not worth
        // the snap.
        this._turnDir = 1;
        this._turnFrom = this._heading;
        this._turnTo = travelHeading;
        // No entry ramp. A reversed entry blends two poses 180Â° apart, and a
        // quaternion blend at exactly 180Â° picks its path by HEMISPHERE â€” it
        // went the opposite way to the ramp and the two STACKED into a spin.
        // Reversed entry is therefore a hard cut (heading swaps to the target
        // the same frame the pre-turned clip lands â€” verified spin-free); the
        // ramp maths stay on the EXIT, where the blend path cooperates.
        this._turnRamp = null;
        this._state = 'turn';
        this._turnT = 0; // the responsiveness cap's clock (Â§18.35)
        this.animate('turn');
      }
    }

    if (this._state === 'turn') {
      // Pivot in place: no translation. The turn clip carries its own root
      // rotation (the hips yaw 180Â° inside the animation), so the heading must
      // NOT sweep alongside it â€” that double-rotated her (a full 360Â° spin on
      // the reversed turn). Instead the heading HOLDS (origin for forward
      // playback, target for reversed), and every hand-off is a RAMP over the
      // `turnBlend` crossfade: the mixer blends the clip's 180Â° root yaw
      // linearly in angle, so a heading lerp over the same window cancels it
      // EXACTLY while the limbs blend â€” smooth legs, no snap, no spin.
      this._tickTurnRamp(dt);
      this._applyHeading();
      // RESPONSIVENESS CAP (Â§18.35): a turn may look like a pivot but it must
      // never FEEL like a lock. Two escapes, both dat-tunable:
      //  - `(turnMove 0.5)` â€” keep translating along the new travel direction
      //    at a fraction of walk speed while the pivot plays (0 = plant).
      //  - `(turnMaxTime 0.4)` â€” the pivot's time budget; when it runs out
      //    the walk takes over exactly as if the clip had finished.
      this._turnT = (this._turnT ?? 0) + dt;
      const turnMove = Math.max(0, Math.min(1, Number(this.turnMove ?? 0.5)));
      if (turnMove > 0 && (axF || axR)) {
        const speed = (Number(this.speed) || 3) * turnMove;
        this.x = (this.x ?? 0) + mx * speed * dt;
        this.z = (this.z ?? 0) + mz * speed * dt;
      }
      const cap = Math.max(0.1, Number(this.turnMaxTime ?? 0.4));
      if (this._turnPhase !== 'exit' && this._turnT >= cap) this._tpcClipEnd();
      if (this._turnPhase === 'exit' && !this._turnRamp) {
        this._state = 'move'; // the walk is already playing; just hand over
        this._turnPhase = null;
      } else if (this._turnPhase !== 'exit' && !axF && !axR) {
        // Keys released mid-turn: fall out to idle. (A reversed-hold abort can
        // show a brief yaw settle â€” rare, accepted.)
        this._turnPhase = null;
        this._turnRamp = null;
        this._state = 'idle';
        this.animate('idle');
      }
    } else if (axF || axR) {
      const speed = Number(this.speed) || 3;
      this.x = (this.x ?? 0) + mx * speed * dt;
      this.z = (this.z ?? 0) + mz * speed * dt;

      // MOUSE-STEER: while moving, an actively-rotating camera turns the body
      // to face where the camera looks â€” drag the mouse mid-walk and she
      // curves with it. A still mouse leaves the directional system in
      // charge, and idling never steers (the free orbit is for looking at
      // your own character). Steering replaces travel-facing this frame.
      const steering = this._grounded && cam?._lookMoved;
      if (steering) {
        const camForward = (cam._yaw ?? 0) + 180 + (Number(this.faceOffset) || 0);
        const rate = (Number(this.turnRate) || 540) * dt;
        this._heading = turnToward(this._heading ?? 0, camForward, rate);
        this._applyHeading();
      } else if (wanted === 'move') {
        // Only 'move' turns to face travel. Strafes and backward diagonals
        // HOLD the facing â€” that is what makes their directional clips read:
        // the body keeps fronting its line while the legs cross-step.
        const rate = (Number(this.turnRate) || 540) * dt;
        this._heading = turnToward(this._heading ?? 0, travelHeading, rate);
        this._applyHeading();
      }
    }

    // -- gravity, ground, jump -------------------------------------------- //
    // Cast from knee height downward so steps and the cube's top are landable.
    // groundInfo rides the same single raycast and also says WHOSE floor it
    // is â€” the footstep machine reads `groundType` dat off that element.
    const gInfo =
      this.world?.env3d?.groundInfo?.(this, this.x ?? 0, this.z ?? 0, (this.y ?? 0) + 0.5) ??
      null;
    this._groundEl = gInfo?.el ?? null;
    const groundY =
      gInfo?.y ??
      this.world?.env3d?.groundAt?.(this, this.x ?? 0, this.z ?? 0, (this.y ?? 0) + 0.5) ??
      this._floorY;

    // No jumping mid-pivot: the turn owns the body until it finishes.
    if (this._grounded && this._state !== 'turn' && input.pressed(ctl.jump)) {
      this._vy = Number(this.jumpSpeed) || 5;
      this._grounded = false;
      this.world?.loop?.dispatchTo(this, 'onJump');
    }

    // GROUND SNAP: walking DOWN a slope drops the floor a few millimetres a
    // frame â€” treating that as airborne restarted the fall clip and fired
    // onLand every other frame (the slope machine-gunned "[Player] landed").
    // While grounded, any floor within `snapDown` below is still FLOOR: her
    // feet follow it. Only a genuine drop (past the tolerance â€” a plaza edge)
    // starts a fall; a jump leaves the ground through `_grounded`, which the
    // snap never touches.
    const snap = Math.max(0, Number(this.snapDown ?? 0.5));
    if (!this._grounded || (this.y ?? 0) > groundY + snap) {
      this._vy -= (Number(this.gravity) || 14) * dt;
      let ny = (this.y ?? 0) + this._vy * dt;
      if (ny <= groundY && this._vy <= 0) {
        ny = groundY;
        this._vy = 0;
        if (!this._grounded) this.world?.loop?.dispatchTo(this, 'onLand');
        this._grounded = true;
      } else {
        this._grounded = false;
      }
      this.y = ny;
    } else {
      this.y = groundY; // grounded: follow the floor, up steps and down grades
    }

    // -- the animation state machine --------------------------------------- //
    // 'turn' owns its own exit (onFinished / key release above); everything
    // else follows the physics + input pattern computed this frame.
    if (this._state !== 'turn') {
      const state = !this._grounded ? 'air' : wanted;
      if (state !== this._state) {
        this._state = state;
        this.animate(state);
      }
    }

    // -- head look (Â§18.35): the gaze leads the body ------------------------ //
    // While the camera points somewhere the body doesn't face, the head (and
    // a share of neck) turns toward it â€” clamped to `(headLookMax)`, ramped by
    // the renderer's procedural layer, off during one-shots (the clip owns
    // the spine) and past ~100Â° (nobody cranes at their own camera).
    {
      const lookOn = !(this.headLook === false || this.headLook === 'false');
      let look = null;
      if (
        lookOn &&
        this._grounded &&
        this._state !== 'attack' &&
        this._state !== 'interact' &&
        this._state !== 'turn'
      ) {
        const camForward = (cam?._yaw ?? 0) + 180 + (Number(this.faceOffset) || 0);
        let d = ((camForward - (this._heading ?? 0) + 540) % 360) - 180;
        if (Math.abs(d) <= 100) {
          const max = Math.max(0, Number(this.headLookMax ?? 60));
          d = Math.max(-max, Math.min(max, d));
          const pitch = Math.max(-20, Math.min(20, (cam?._pitch ?? 0) * 0.5));
          look = [d, pitch];
        }
      }
      if (look || this.components?.model?.headLook) this.setComponent('model', 'headLook', look);
    }

    // -- action buttons ---------------------------------------------------- //
    // The EQUIPPED item hears them too â€” that is the wield framework's hook:
    // a lance script gives itself (runInfo stab onPrimary) and it fires while
    // wielded (Â§18.11).
    if (input.pressed(ctl.primary)) {
      this.world?.loop?.dispatchTo(this, 'onPrimary');
      if (this.equipped) this.world?.loop?.dispatchTo(this.equipped, 'onPrimary', this);
      // A WEAPON in hand turns the primary into a SWING: the `attack` one-shot
      // (grounded, not mid-turn â€” the guards above already returned for
      // interact/attack). Hooks above still fired â€” a script hears the hit.
      const w = this.equipped;
      if (w && (w.isWeapon === true || w.isWeapon === 'true') && (w.attack || this.attack) && this._grounded && this._state !== 'turn') {
        // A PROJECTILE weapon fires where the camera looks â€” if she is idling
        // some other way, snap her to the aim line at the trigger pull so the
        // muzzle â†’ focal triangle reads true (Â§18.16). Melee keeps its facing.
        if (w.projectile) {
          const focal = this._aimFocal(Number(this.aimDist) || 60); // lock-aware
          if (focal) {
            // Face the CAMERA's aim bearing (origin â†’ focal), never her own
            // position â†’ focal: a hit NEARER than the character (a tree
            // between camera and player) flips the player-relative bearing
            // and spun her to face backwards at the trigger pull.
            this._heading =
              Math.atan2(focal.x - focal.ox, focal.z - focal.oz) / DEG +
              (Number(this.faceOffset) || 0);
            this._applyHeading();
            // The gaze must not fight a snapped body (Â§18.36): clear the
            // head-look NOW â€” the renderer hard-drops a cleared gaze, so the
            // fire clip owns the whole spine from its first frame.
            if (this.components?.model?.headLook) this.setComponent('model', 'headLook', null);
          }
        }
        this._state = 'attack';
        this._attackHit = false; // one victim per swing
        this._projFired = false; // one round per trigger pull
        this.animate('attack');
        return;
      }
    }
    if (input.pressed(ctl.secondary)) {
      this.world?.loop?.dispatchTo(this, 'onSecondary');
      if (this.equipped) this.world?.loop?.dispatchTo(this.equipped, 'onSecondary', this);
    }
  }
}

AE1ThirdPersonCharacter.agsDef = {
  name: 'ThirdPersonCharacter',
  extends: null,
  // Includes Model's hook: hand-built agsDef does not merge up the chain the
  // way compiled defs do, and losing _modelBegin would silently drop the idle.
  // _tpcClipEnd rides onFinished â€” the renderer fires it when a one-shot (the
  // 180 turn) runs out, the same mode Sprite and Video use.
  runInfo: { _modelBegin: ['onLoad'], _tpcBegin: ['onLoad'], _tpcTick: ['onTick'], _tpcClipEnd: ['onFinished'] },
};

/**
 * Movement FEEL. `speed` m/s, `jumpSpeed` m/s up, `gravity` m/sÂ², `turnRate`
 * deg/s toward travel, `faceOffset` deg for models authored facing the other
 * way. Model's own dat (animations, idle, animLibs) is inherited.
 *
 * The state clips, each a friendly alias / real name / "file.glb" â€” empty =
 * the bind pose, so a character with only an idle degrades gracefully:
 * `move` (walking), `turn` (the one-shot 180 reversal; auto-reversed on every
 * other turn), `strafeLeft`/`strafeRight` (pure lateral), `backLeft`/
 * `backRight` (diagonal backward), `air` (jumping/falling).
 */
AE1ThirdPersonCharacter.agsDat = {
  ...AE1Model.agsDat,
  speed: 3,
  jumpSpeed: 5,
  gravity: 14,
  // The health pool (Â§18.28). Zero does nothing yet, on purpose.
  health: 100,
  // Â§18.43 lock-on: acquisition range (release leash is 1.25Ã—), and the
  // indicator's media â€” a DAT so the exporter's name scan ships the disc.
  lockRange: 40,
  lockMarkerMedia: 'lock_ring.glb',
  lockMarkerNode: 'lock_ring', // the glb's root node (alchemy_circle etc.)
  // How far below her feet the floor may drop in one step and still be FLOOR
  // (slope-following); past this, it's a fall. Raise for steeper terrain.
  snapDown: 0.5,
  turnRate: 540,
  // Seconds of crossfade at every turn hand-off (entry, and turnâ†’walk). The
  // heading ramp is timed to this window so poses blend without yaw drift.
  turnBlend: 0.25,
  faceOffset: 0,
  move: '',
  air: '',
  turn: '',
  interact: '',
  attack: '',
  strafeLeft: '',
  strafeRight: '',
  backLeft: '',
  backRight: '',
  // Per-state playback tweaks: (animOpts (air (loop false) (startFrame 12))).
  // See animOptsFor for the options.
  animOpts: [],
  // Socket overrides: (sockets (rightHand "mixamorig:RightHand")). Empty =
  // the renderer auto-detects a right hand by bone name (Â§18.11).
  sockets: [],
  // Footsteps by surface (Â§18.20): (footsteps (floor "a.mp3") (grass "b.mp3"))
  // maps a floor element's (groundType â€¦) dat to a walk loop. Unmapped =
  // silent walking.
  footsteps: [],
  footstepVolume: 0.8,
  // The procedural layer (Â§18.24) â€” a BIAS over the playing clips, never a
  // replacement. reachWeight: how far the right arm bends toward an
  // interact target (0 = off). footPlant: settle the body into uneven
  // ground and tilt the feet to the slope while grounded.
  reachWeight: 0.5,
  footPlant: true,
  // The aim triangulation (Â§18.16): draw the camera â†’ focal â†’ muzzle lines,
  // and how far the focal point sits when the view hits nothing.
  drawAim: false,
  aimDist: 60,
  // Feel (Â§18.35). turnMove: fraction of walk speed kept while the 180 pivot
  // plays (0 = plant in place). turnMaxTime: the pivot's time budget â€” when
  // it runs out the walk takes over as if the clip had finished. headLook:
  // the gaze leads the body toward the camera bearing, clamped to
  // headLookMax degrees, neck + head split in the procedural layer.
  turnMove: 0.5,
  turnMaxTime: 0.4,
  headLook: true,
  headLookMax: 60,
};

defineDatAccessors(AE1ThirdPersonCharacter);
