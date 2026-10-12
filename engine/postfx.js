/**
 * AE1 - PostFX element (§18.47): the scene-authorable face of the shader
 * layer. Drop one in a scene and the renderer composites every frame
 * through the filmic uber-pass (engine/three3d/postfx.js); every dat below
 * is a live slider in Properties. No element, no cost — the renderer keeps
 * its plain path.
 *
 * The AUTOFOCUS is this element's real job: each tick it measures the
 * camera → character distance (the same focal the aim system uses — chest
 * height, the thing you're looking at) and eases `_focusDist` toward it at
 * `dofFocusLag` — the CinematicDOF "AutoFocusTransitionSpeed" feel from
 * Austin's own the reference action game ReShade preset. Rack-focus moments (lock-on swings,
 * scene entries) glide instead of popping. `(dofFocusDist)` > 0 pins manual
 * focus instead.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1PostFX extends AE1Element {
  _focusDist = 4;
  _drLast = 0; // dynamic resolution: wall-clock of the previous tick
  _drEma = 0; // smoothed frame ms
  _drHold = 0; // seconds until the next adjustment

  /** DYNAMIC RESOLUTION (§18.59): hold a target fps by walking renderScale,
   *  console-game style. WALL-CLOCK ONLY — tick dt is simulation time, and
   *  hit stop / kill slow-mo / SLOW_MO would read as "fast frames" and pump
   *  the resolution up mid-freeze. Falls fast (heavy scenes hurt now), rises
   *  slowly (with hysteresis, so it never see-saws around the target). */
  _drTick() {
    const now = performance.now();
    const raw = this._drLast ? now - this._drLast : 0;
    this._drLast = now;
    if (raw <= 0 || raw > 250) return; // first tick / tab-return spike
    this._drEma = this._drEma ? this._drEma * 0.9 + raw * 0.1 : raw;
    this._drHold -= raw / 1000;
    if (this._drHold > 0) return;
    this._drHold = 1; // one adjustment per second
    const target = 1000 / Math.max(20, Number(this.targetFps) || 60);
    const lo = Math.max(0.4, Number(this.minScale) || 0.5);
    const hi = Math.min(1, Number(this.maxScale) || 1);
    const s = Math.min(hi, Math.max(lo, Number(this.renderScale) || 1));
    if (this._drEma > target * 1.12 && s > lo) {
      this.renderScale = Math.max(lo, +(s - 0.06).toFixed(2));
    } else if (this._drEma < target * 0.85 && s < hi) {
      this.renderScale = Math.min(hi, +(s + 0.03).toFixed(2));
    }
  }

  _pfxTick(dt) {
    const scn = this.world?.scene;
    if (!scn) return;
    if (this.dynamicRes === true || this.dynamicRes === 'true') this._drTick();
    const manual = Number(this.dofFocusDist) || 0;
    if (manual > 0) {
      this._focusDist = manual;
      return;
    }
    const cam = scn.all().find((e) => typeof e._camTick === 'function');
    const t = scn.all().find((e) => e._inv && typeof e.equipIndex === 'function');
    if (!cam || !t) return;
    const lookY = (t.y ?? 0) + 1.4; // the chest, where eyes rest
    const want = Math.hypot(
      (cam.x ?? 0) - (t.x ?? 0),
      (cam.y ?? 0) - lookY,
      (cam.z ?? 0) - (t.z ?? 0),
    );
    const lag = Math.max(0.01, Number(this.dofFocusLag) || 0.2);
    // exponential glide: `lag` ≈ seconds to close ~63% of the gap
    this._focusDist += (want - this._focusDist) * Math.min(1, dt / lag);
  }
}

AE1PostFX.agsDef = {
  name: 'PostFX',
  extends: null,
  runInfo: { _pfxTick: ['onTick'] },
};

AE1PostFX.agsDat = {
  enabled: true,
  // -- the cinematic DOF (the headliner) ----------------------------------- //
  dofEnabled: true,
  dofAperture: 0.35, // CoC scale — bigger = shallower focus
  dofMaxBlur: 7, // blur radius ceiling, px at 1080p-ish
  // §18.60: metres around the focal plane that stay PERFECTLY crisp — the
  // blur ramp starts beyond this band. 0 = classic thin-focus lens (old
  // behavior); ~12-16 = "only the distant walls blur, not the room".
  dofSharpRange: 0,
  dofFocusLag: 0.2, // autofocus glide, seconds (the ReShade transition feel)
  dofFocusDist: 0, // >0 pins manual focus (metres); 0 = follow the character
  // -- the film layer ------------------------------------------------------ //
  grainAmount: 0.05, // animated hash grain (§ dialed from 0.1 — gentler sky speckle)
  vignette: 0.22,
  caAmount: 0.12, // radial chromatic aberration, quadratic falloff
  // -- bloom (§18.50): emissive surfaces glow — the reference action game marks glow through
  // emissive maps, three renders them bright, the threshold extracts them
  bloomStrength: 0.55,
  bloomThreshold: 0.75,
  // -- performance (§18.53) ------------------------------------------------ //
  // Render the 3D scene at this fraction of the canvas and upscale in the
  // final pass: 0.75 returns ~44% of GPU fragment cost; the film layer
  // hides the softness. 1 = native. Clamped to [0.4, 1].
  renderScale: 1,
  // -- dynamic resolution (§18.59) ----------------------------------------- //
  // Auto-walk renderScale to hold targetFps (wall-clock measured, one
  // adjustment per second, falls fast / rises slow with hysteresis).
  // renderScale becomes the STARTING value; min/maxScale bound the walk.
  dynamicRes: false,
  targetFps: 60,
  minScale: 0.5,
  maxScale: 1,
};

defineDatAccessors(AE1PostFX);
