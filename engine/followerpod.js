/**
 * AE1 — FollowerPod (§18.55): the floating companion. the reference game's pod — here
 * wearing the companion pod — hovers at the host character's shoulder, bobs,
 * lags behind movement on a spring, faces where the camera faces, and
 * shoots on its own button. another recent action game's drone is the same creature.
 *
 * Design rules, in the engine's usual shape:
 *
 *  - The pod is its OWN element with its own model + clips (Idle/Fire/
 *    Special baked from the game's <asset> pod motion set — the DLC skins
 *    share the pod skeleton, so the book skin plays pod motions unretargeted).
 *  - The HOST stays the root of truth: the pod reads the host's position
 *    and the camera's yaw every tick and chases a camera-relative shoulder
 *    offset. It never pushes back. `host` dat names the element; empty
 *    auto-finds the player (the inventory-bearing character).
 *  - AIRCRAFT INTEGRATION (Austin's rule): a pod vanishes while its host
 *    pilots a flight craft. `host._pilotCraft` is the truth the aircraft
 *    already maintains — set on board, cleared on dismount — so the pod
 *    needs no wiring into aircraft.js at all.
 *  - FIRE is a held button (`podFire` dat, keyboard + pad tokens like every
 *    mapping in this engine): rate-limited PodBolts fly at the lock target
 *    when the host has one, else at the camera's aim point. SPECIAL
 *    (`podSpecial`) is a charged shot on a cooldown — a heavy bolt that
 *    detonates into a friendly AoeWave (the §18.44 wave, `_friendly` mode,
 *    same as the flight craft's AOE).
 *  - PodBolt mirrors AE1EnemyRound but hunts the OTHER side: it damages
 *    anything with `takeDamage` in the NPC/Enemy family and never the
 *    player. Damage rides the bolt from the pod's dats at spawn.
 *
 * Events a script can hear: onFire (each bolt), onSpecial (the charged
 * shot), onPodHit (a bolt connected: (victim, damage)).
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1Model } from './model3d.js';
import { AE1AoeWave } from './enemyattacks.js';

const POD_DEG = Math.PI / 180;

function findPlayer(scn) {
  return scn?.all().find((e) => e._inv && typeof e.equipIndex === 'function') ?? null;
}

function findCamera(scn) {
  return scn?.all().find((e) => typeof e._camTick === 'function') ?? null;
}

/* ------------------------------------------------------------------------- */

export class AE1FollowerPod extends AE1Model {
  _podFireT = 0; // seconds until the next bolt may fire
  _podSpecialT = 0; // seconds until the special is ready again
  _podClip = null;
  _podBob = 0;
  _podHidden = false;
  _podPlaced = false;

  /* -- helpers ------------------------------------------------------------ */

  _podPlay(name, { loop = true, fade = 0.2 } = {}) {
    if (!name || this._podClip === name) return;
    this._podClip = String(name);
    this.playAnimation(this._podClip, { loop, fade });
  }

  _podFx(name, x, y, z) {
    if (!name) return;
    const el = this.find(String(name));
    if (!el) return;
    if (x !== undefined) {
      el.x = x;
      el.y = y;
      el.z = z;
    }
    el.burst?.();
  }

  _podHost() {
    const name = String(this.host || '');
    if (name) return this.find(name) ?? null;
    return findPlayer(this.world?.scene);
  }

  _podHide(hide) {
    if (this._podHidden === !!hide) return;
    this._podHidden = !!hide;
    this.visible = !hide;
  }

  /** Where the bolts should go: the host's lock target wins, then the
   *  camera's crosshair ray, then plain camera forward. */
  _podAimTarget(host, cam) {
    const t = host?._lockTarget;
    if (t && !t._dead && t.visible !== false) {
      const b = this.world?.env3d?.boundsOf?.(t);
      if (b) {
        return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
      }
      return { x: t.x ?? 0, y: (t.y ?? 0) + 0.8, z: t.z ?? 0 };
    }
    const p = this.world?.env3d?.aimPoint?.(this, Number(this.aimDist) || 60);
    if (p) return p;
    const yaw = (cam?._yaw ?? 0) * POD_DEG;
    const pitch = (cam?._pitch ?? 0) * POD_DEG;
    return {
      x: (this.x ?? 0) - Math.sin(yaw) * Math.cos(pitch) * 30,
      y: (this.y ?? 0) - Math.sin(pitch) * 30,
      z: (this.z ?? 0) - Math.cos(yaw) * Math.cos(pitch) * 30,
    };
  }

  /* -- the tick ------------------------------------------------------------ */

  _podTick(dt) {
    const host = this._podHost();
    const cam = findCamera(this.world?.scene);
    if (!host) return;

    // -- flight craft rule: the pod vanishes while its host pilots ---------- //
    // (POD_HIDE is the §18.56 debug wall's version of the same idea)
    if (this.world?.debugFlags?.POD_HIDE
      || ((this.hideWhenPiloted ?? true) !== false && host._pilotCraft)) {
      this._podHide(true);
      return;
    }
    if (this.world?.debugFlags?.POD_NO_CD) this._podSpecialT = 0; // §18.56
    this._podHide(host.visible === false); // a hidden host hides its pod too
    if (this._podHidden) return;

    // -- follow: camera-relative shoulder offset, spring + bob ------------- //
    const yaw = (cam?._yaw ?? 0) * POD_DEG;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const side = Number(this.offsetSide);
    const fwd = Number(this.offsetForward);
    this._podBob += dt * (Number(this.bobFreq) || 1.4) * Math.PI * 2;
    const bob = Math.sin(this._podBob) * (Number(this.bobAmp) || 0.05);
    const tx = (host.x ?? 0) + rx * side + fx * fwd;
    const ty = (host.y ?? 0) + (Number(this.offsetHeight) || 1.9) + bob;
    const tz = (host.z ?? 0) + rz * side + fz * fwd;
    if (!this._podPlaced) {
      // first sight of the host: appear AT the seat, never lerp from origin
      this._podPlaced = true;
      this.x = tx;
      this.y = ty;
      this.z = tz;
    } else {
      const k = Math.min(1, (Number(this.followLag) || 7) * dt);
      this.x = (this.x ?? 0) + (tx - (this.x ?? 0)) * k;
      this.y = (this.y ?? 0) + (ty - (this.y ?? 0)) * k;
      this.z = (this.z ?? 0) + (tz - (this.z ?? 0)) * k;
    }

    // -- face where the camera faces (bolts fly that way too) -------------- //
    this.rotationY = (cam?._yaw ?? 0) + 180 + (Number(this.faceOffset) || 0);

    // -- buttons ------------------------------------------------------------ //
    // ONE button, two gestures (Austin's spec): tap-and-hold = the bolt
    // stream, DOUBLE-TAP = the special. The same `podFire` token string
    // carries keyboard and pad (KeyQ + PadRB), so the gesture grammar is
    // identical on both. `podSpecial` remains as an OPTIONAL dedicated
    // button — empty by default.
    const input = this.world?.input3d;
    this._podFireT = Math.max(0, this._podFireT - dt);
    this._podSpecialT = Math.max(0, this._podSpecialT - dt);
    this._podTapT = Math.max(0, (this._podTapT ?? 0) - dt);
    let wantSpecial = false;
    if (input?.pressed?.(String(this.podFire || ''))) {
      if (this._podTapT > 0) {
        wantSpecial = true; // second tap inside the window
        this._podTapT = 0;
      } else {
        this._podTapT = Math.max(0.1, Number(this.doubleTapTime) || 0.3);
      }
    }
    if (input?.pressed?.(String(this.podSpecial || ''))) wantSpecial = true;
    if (wantSpecial && this._podSpecialT <= 0) {
      this._podSpecialT = Math.max(0.5, Number(this.specialCooldown) || 6);
      this._podFireT = 0.35; // the stream takes a beat after the big shot
      this._podShoot(host, cam, true);
      this._podPlay(String(this.clipSpecial), { loop: false, fade: 0.1 });
      this.world?.input3d?.rumble?.(0.5, 0.8, 250);
      this.world?.loop?.dispatchTo(this, 'onSpecial');
      return; // let the one-shot breathe this tick
    }
    const firing = !!input?.down?.(String(this.podFire || ''));
    if (firing && this._podFireT <= 0) {
      this._podFireT = 1 / Math.max(0.5, Number(this.fireRate) || 7);
      this._podShoot(host, cam, false);
    }

    // -- clips -------------------------------------------------------------- //
    if (this._podClip === String(this.clipSpecial) && firing === false) {
      // the special one-shot plays out; playAnimation's onFinished loops are
      // not wired here, so fall back once the cooldown window has opened
      if (this._podSpecialT < Math.max(0.5, Number(this.specialCooldown) || 6) - 1.2) {
        this._podClip = null;
      }
    }
    if (this._podClip !== String(this.clipSpecial) || this._podClip === null) {
      this._podPlay(firing ? String(this.clipFire) : String(this.clipIdle));
    }
  }

  /* -- shooting ------------------------------------------------------------ */

  _podShoot(host, cam, special) {
    const scn = this.world?.scene;
    if (!scn) return;
    const aim = this._podAimTarget(host, cam);
    const mf = Number(this.muzzleForward) || 0.45;
    const yaw = (this.rotationY ?? 0) * POD_DEG;
    const ox = (this.x ?? 0) + Math.sin(yaw) * mf;
    const oy = (this.y ?? 0) - (Number(this.muzzleDown) || 0.1);
    const oz = (this.z ?? 0) + Math.cos(yaw) * mf;
    let dx = aim.x - ox;
    let dy = aim.y - oy;
    let dz = aim.z - oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    if (!special) {
      // a touch of gatling spread keeps the stream alive
      const s = ((Number(this.boltSpread) || 1.5) * POD_DEG);
      dx += (Math.random() - 0.5) * s;
      dy += (Math.random() - 0.5) * s;
      dz += (Math.random() - 0.5) * s;
      const l2 = Math.hypot(dx, dy, dz) || 1;
      dx /= l2;
      dy /= l2;
      dz /= l2;
    }
    const el = new AE1PodBolt({
      id: 'podbolt-' + Math.random().toString(36).slice(2, 10),
      name: '__PodBolt',
      type: 'object',
      visible: true,
      x: ox,
      y: oy,
      z: oz,
      scaleX: special ? Number(this.specialBoltScale) || 2.2 : 1,
      scaleY: special ? Number(this.specialBoltScale) || 2.2 : 1,
      scaleZ: special ? Number(this.specialBoltScale) || 2.2 : 1,
      components: { model: { media: String(this.boltMedia || 'pod_bolt.glb'), node: String(this.boltNode || 'pod_bolt') } },
    });
    el._dir = { x: dx, y: dy, z: dz };
    el._speed = special ? Number(this.specialSpeed) || 16 : Number(this.boltSpeed) || 30;
    el._damage = special ? Number(this.specialDamage) || 40 : Number(this.boltDamage) || 6;
    el._range = Number(this.boltRange) || 40;
    el._attacker = host; // kills credit the HOST — combat feel hooks fire there
    el._pod = this;
    el._special = !!special;
    scn.add(el);
    this.world?.loop?.rescan?.();
    this._podFx(String(this.muzzleFx || ''));
    if (!special) this.world?.loop?.dispatchTo(this, 'onFire');
  }
}

AE1FollowerPod.agsDef = {
  name: 'FollowerPod',
  extends: null,
  runInfo: { _podTick: ['onTick'] },
};

AE1FollowerPod.agsDat = {
  // -- who to follow (empty = auto-find the player) ------------------------ //
  host: '',
  hideWhenPiloted: true,
  // -- the hover seat: camera-relative shoulder offset --------------------- //
  offsetSide: -0.9, // negative = the camera's LEFT, the reference game's side
  offsetHeight: 1.9,
  offsetForward: 0.15,
  followLag: 7, // spring stiffness, 1/s — lower floats lazier
  // the AUTHORED idle clip already hovers (<asset>_0000 breathes on its
  // own) — the procedural bob is only a slow drift on top. Stacking a
  // fast sine here read as frantic bobbing (Austin's report); 0 is a
  // fine value when the clip carries the motion.
  bobAmp: 0.02,
  bobFreq: 0.35,
  faceOffset: 0, // deg trim if the model's forward axis disagrees
  // -- clips (baked from the <asset> pod motion set) ------------------------ //
  clipIdle: 'Idle',
  clipFire: 'Fire',
  clipSpecial: 'Special',
  // -- buttons (keyboard + pad tokens, same grammar as the Controller) ----- //
  // ONE button, two gestures: tap-and-hold streams bolts, a double-tap
  // inside `doubleTapTime` fires the special — identical on keyboard and
  // pad. `podSpecial` stays as an optional dedicated extra button.
  podFire: 'KeyQ PadRB',
  podSpecial: '',
  doubleTapTime: 0.3,
  // -- the stream ---------------------------------------------------------- //
  boltMedia: 'pod_bolt.glb',
  boltNode: 'pod_bolt',
  fireRate: 7, // bolts per second while held
  boltSpeed: 30,
  boltDamage: 6,
  boltRange: 40,
  boltSpread: 1.5, // degrees
  muzzleForward: 0.45,
  muzzleDown: 0.1,
  aimDist: 60,
  // -- the special: a charged shot that detonates into a friendly wave ----- //
  specialDamage: 40,
  specialRadius: 6,
  specialWaveSpeed: 9,
  specialBoltScale: 2.2,
  specialSpeed: 16,
  specialCooldown: 6,
  // -- named Particles elements (empty = none) ----------------------------- //
  muzzleFx: '',
  hitFx: '',
  specialFx: '',
};

defineDatAccessors(AE1FollowerPod);

/* ------------------------------------------------------------------------- */

/**
 * The pod's projectile — AE1EnemyRound's mirror image. Travels straight,
 * damages the first ENEMY-family element it overlaps (anything with
 * `takeDamage` + `_npcAnimate`, never the player, never the pod's host),
 * then pops. A special bolt detonates into a friendly AoeWave instead of
 * just popping — the same §18.44 wave the flight craft's AOE uses.
 */
export class AE1PodBolt extends AE1Element {
  _dir = { x: 0, y: 0, z: 1 };
  _speed = 30;
  _damage = 6;
  _attacker = null;
  _pod = null;
  _special = false;
  _range = 40;
  _flown = 0;

  _boltTick(dt) {
    const scn = this.world?.scene;
    if (!scn) return;
    const step = this._speed * dt;
    this.x = (this.x ?? 0) + this._dir.x * step;
    this.y = (this.y ?? 0) + this._dir.y * step;
    this.z = (this.z ?? 0) + this._dir.z * step;
    this._flown += step;
    this.rotationY = ((this.rotationY ?? 0) + 420 * dt) % 360;
    for (const e of scn.all()) {
      if (e === this._attacker || e === this._pod) continue;
      if (typeof e.takeDamage !== 'function' || typeof e._npcAnimate !== 'function') continue;
      if (e._dead || e.visible === false) continue;
      const b = this.world?.env3d?.boundsOf?.(e);
      const cx = b ? (b.min.x + b.max.x) / 2 : (e.x ?? 0);
      const cy = b ? (b.min.y + b.max.y) / 2 : (e.y ?? 0) + 0.8;
      const cz = b ? (b.min.z + b.max.z) / 2 : (e.z ?? 0);
      const pad = b ? Math.max(0.35, (b.max.x - b.min.x) / 2) : 0.5;
      const dx = (this.x ?? 0) - cx;
      const dy = (this.y ?? 0) - cy;
      const dz = (this.z ?? 0) - cz;
      if (dx * dx + dz * dz <= pad * pad && Math.abs(dy) <= Math.max(1.2, pad)) {
        e.takeDamage(this._damage, this._attacker ?? this);
        this._pod?._podFx?.(String(this._pod.hitFx || ''), this.x, this.y, this.z);
        if (this._pod) this._pod.world?.loop?.dispatchTo(this._pod, 'onPodHit', e, this._damage);
        return this._boltPop(true);
      }
    }
    if (this._flown >= this._range) this._boltPop(false);
  }

  _boltPop(hit) {
    if (this._special && this._pod) {
      // the charged shot's detonation: a friendly wave from the impact point
      const pod = this._pod;
      const wave = new AE1AoeWave({
        id: 'podwave-' + Math.random().toString(36).slice(2, 10),
        name: '__PodWave',
        type: 'object',
        visible: true,
        x: this.x,
        y: this.y,
        z: this.z,
        scaleX: 0.1,
        scaleY: 0.1,
        scaleZ: 0.1,
        // invisible wave — the specialFx Particles burst carries the visual,
        // the flight-craft AOE precedent (Austin retired the orange orb)
      });
      wave._mode = 'orb';
      wave._friendly = true;
      wave._speed = Number(pod.specialWaveSpeed) || 9;
      wave._maxR = Number(pod.specialRadius) || 6;
      wave._damage = Math.round((Number(pod.specialDamage) || 40) / 2);
      wave._attacker = this._attacker ?? pod;
      this.world?.scene?.add?.(wave);
      pod._podFx?.(String(pod.specialFx || ''), this.x, this.y, this.z);
    }
    this.world?.scene?.remove?.(this.id);
    this.world?.loop?.rescan?.();
  }
}

AE1PodBolt.agsDef = {
  name: 'PodBolt',
  extends: null,
  runInfo: { _boltTick: ['onTick'] },
};

AE1PodBolt.agsDat = {};

defineDatAccessors(AE1PodBolt);
