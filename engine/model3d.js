/**
 * AE1 - 3D model animation base.
 *
 * `AE1Model` is the `(extends Model)` built-in: a 3D element whose skeleton plays
 * animation clips, driven by Angel Script. The state machine IS the script —
 * `onLoad` plays the idle, `onClick` plays a wave — exactly like Sprite and the
 * dialogue delegate, where behaviour lives in the author's methods and the engine
 * just runs them (DESIGN.md §18).
 *
 * The element carries a `model` component (media, node, and the animation STATE:
 * `clip`, `loop`, `speed`) that the 3D renderer reads and plays. This class only
 * SETS that state, through the standard-library `playAnimation` — it never touches
 * three.js, so the same script drives the editor viewport and (once it exists) the
 * shipped game identically.
 *
 * Clips get FRIENDLY NAMES here, because a real glTF clip is named things like
 * `Armature|mixamo.com|Layer0`. `(animations (idle "Armature|mixamo.com|Layer0"))`
 * maps `play("idle")` to that string. No alias? The name is used as-is.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Model extends AE1Element {
  /**
   * Play a clip by friendly name (resolved through the alias map) or real name.
   * `play("walk")`, `play("walk", { loop: false })`.
   */
  play(name, opts = {}) {
    return this.playAnimation(this.resolveClip(name), opts);
  }

  /** Freeze on the current pose. */
  stop() {
    return this.stopAnimation();
  }

  /**
   * Return to the BIND pose (the T-pose) — not a freeze, a reset. `'__bind__'`
   * is a sentinel the 3D renderer understands: stop the action AND re-pose the
   * skeleton (a stopped mixer leaves bones wherever the last frame put them).
   */
  bindPose() {
    return this.setComponent('model', 'clip', '__bind__');
  }

  /**
   * `(animLibs ("file.glb"))` — glbs whose CLIPS this model may play, meshes
   * ignored. An idle exported as its own glb drives the character's skeleton by
   * bone-name match; the renderer resolves clip names through these after the
   * model's own (DESIGN.md §18.10). Normalised here because the reader
   * collapses a single-item list to its bare string — the same trap as
   * `_aliasList`.
   */
  _libList() {
    const v = this.animLibs;
    if (typeof v === 'string') return v ? [v] : [];
    return Array.isArray(v) ? v.map(String) : [];
  }

  /**
   * The alias map, normalised.
   *
   * The reader collapses a SINGLE-item rest: `(animations (idle "…"))` parses to a
   * flat `["idle", "…"]`, while two aliases give `[["idle","…"],["walk","…"]]`. So
   * one alias arrives shaped differently than many — the same trap the dialogue
   * tree has (DESIGN.md §12.7.2). Wrap the flat single-pair case so the rest of the
   * class sees one shape.
   */
  _aliasList() {
    let list = Array.isArray(this.animations) ? this.animations : [];
    if (list.length && typeof list[0] === 'string') list = [list];
    return list;
  }

  /**
   * A friendly clip name -> its real glTF clip name, via `(animations …)`.
   *
   * dat is author-owned and can hold anything, so every entry is shape-checked; a
   * name with no alias passes straight through (so `play("Armature|…")` also works).
   */
  resolveClip(name) {
    const key = String(name ?? '');
    for (const a of this._aliasList()) {
      if (Array.isArray(a) && a.length >= 2 && String(a[0]) === key) return String(a[1]);
    }
    return key;
  }

  /** The friendly clip names this model declares, for a script to reason about. */
  get clipNames() {
    return this._aliasList().map((a) => (Array.isArray(a) ? String(a[0]) : String(a)));
  }

  /** The clip playing now (its real name), or '' at rest. */
  get animation() {
    return this.components?.model?.clip ?? '';
  }

  /* -- lifecycle --------------------------------------------------------- */

  // Wired by the static agsDef below, so a bare `(extends Model)` with an (idle …)
  // rests on its idle the moment the scene loads — no method required.
  _modelBegin() {
    // dat -> component, so the renderer (which reads ONLY components) can
    // resolve clips through the libraries in play mode too.
    const libs = this._libList();
    if (libs.length) this.setComponent('model', 'libs', libs);
    if (this.idle) this.play(this.idle);
  }
}

AE1Model.agsDef = {
  name: 'Model',
  extends: null,
  runInfo: { _modelBegin: ['onLoad'] },
};

/**
 * `animations` is the alias map: `(animations (idle "…") (walk "…"))`.
 * `idle` is the clip to play on load, by friendly name (or real). Empty idle is
 * fine — the renderer already rests a model on its first clip with no script.
 * `animLibs` names glbs that contribute CLIPS only (meshes ignored).
 */
AE1Model.agsDat = {
  animations: [],
  idle: '',
  animLibs: [],
};

// A bare Model never goes through the compiler, so it needs its own dat accessors.
defineDatAccessors(AE1Model);
