/**
 * AE1 - spritesheet animation.
 *
 * `AE1Sprite` is a built-in base: `(extends Sprite)`. It owns MOTION, and
 * nothing else.
 *
 * It deliberately has NO draw(). The frame is data -- "draw region R of image I"
 * -- and lives in the sprite component, which the default renderer path already
 * draws (renderer.js:frameRect). This class only decides WHICH region, on a
 * clock, and writes it there.
 *
 * That split is the whole design. Every other built-in (Text, Video, Button)
 * owns its draw() and therefore had to reimplement -- or, as it turned out,
 * silently drop -- rotation and flip. A Sprite is the one thing you most want to
 * flip: a walk cycle facing left is the same sheet mirrored. By staying on the
 * default path it gets rotation, flip, opacity, and the still-decoding
 * placeholder for free, and it cannot drift from how a plain sprite renders.
 *
 * It also means the frame attributes are usable WITHOUT this class: a plain
 * element can show frame 4 of an atlas from the Properties panel. `(extends
 * Sprite)` is what you add when you want it to move.
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { getImage } from './media.js';
import { frameGrid } from './renderer.js';

export class AE1Sprite extends AE1Element {
  /* -- the sheet ---------------------------------------------------------- */

  /** How this element's sheet is cut up, or null if it has no sheet yet. */
  get grid() {
    const s = this.components?.sprite;
    if (!s?.media) return null;

    // No onReady callback: a decode finishing mid-animation needs no special
    // handling, because the next tick asks again and the loop redraws anyway.
    const img = getImage(this.world?.mediaBase ?? 'media', s.media, s.ext ?? 'png');
    return frameGrid(img, s);
  }

  /** Frames in the sheet. 0 until the image has decoded. */
  get frameCount() {
    return this.grid?.count ?? 0;
  }

  /** The frame currently showing. */
  get frame() {
    return Math.floor(Number(this.components?.sprite?.frame) || 0);
  }

  set frame(i) {
    this.setComponent('sprite', 'frame', Math.floor(Number(i) || 0));
  }

  /* -- clips -------------------------------------------------------------- */

  /**
   * The active clip as [from, to], or null for "the whole sheet".
   *
   *   (animations (walk 0 7) (idle 8 11))
   *
   * reads as [['walk',0,7],['idle',8,11]] -- nested arrays of primitives, which
   * is exactly what the reader produces, what structuredClone copies, and what
   * serialize()'s JSON comparison can compare. A richer shape (objects, per-clip
   * fps) would quietly break all three.
   *
   * dat is author-owned and can hold ANYTHING, so every field is checked rather
   * than assumed. An author who writes `(animations "walk" "idle")` gets no
   * animation, not a crash in the render loop.
   */
  get range() {
    const name = String(this.animation ?? '');
    if (!name) return null;

    const list = Array.isArray(this.animations) ? this.animations : [];
    for (const clip of list) {
      if (!Array.isArray(clip) || clip.length < 3) continue;
      if (String(clip[0]) !== name) continue;

      const from = Math.floor(Number(clip[1]));
      const to = Math.floor(Number(clip[2]));
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

      // Tolerate a reversed range rather than silently playing nothing.
      return from <= to ? [from, to] : [to, from];
    }

    if (!this._warnedClip) {
      this._warnedClip = true; // once, not once per frame
      console.warn(`[ags] Sprite "${this.name}" — no animation named "${name}".`);
    }
    return null;
  }

  /* -- the standard library ----------------------------------------------- */

  /**
   * Play a clip. `play("walk")`, or `play()` to resume the current one.
   *
   * Restarts from the clip's first frame when the clip CHANGES, and does not when
   * it does not -- so calling play("walk") every frame while a key is held keeps
   * the cycle running instead of freezing it on frame 0. That case is the whole
   * reason this is not a one-liner.
   */
  play(name) {
    if (name !== undefined && String(name) !== String(this.animation ?? '')) {
      this.animation = String(name);
      this._warnedClip = false;
      this._elapsed = 0;
      this.frame = this.range?.[0] ?? 0;
    }
    this.playing = true;
    return this;
  }

  /** Stop on the current frame. */
  stop() {
    this.playing = false;
    return this;
  }

  /** Jump to a frame within the current clip. `gotoFrame(0)` is the first frame. */
  gotoFrame(i) {
    const [from] = this.range ?? [0];
    this.frame = from + Math.floor(Number(i) || 0);
    this._elapsed = 0;
    return this;
  }

  /** Did a `(loop false)` clip reach its end? False forever while looping. */
  get finished() {
    return Boolean(this._finished);
  }

  /* -- playback ----------------------------------------------------------- */

  _spriteBegin() {
    this._elapsed = 0;
    this._finished = false;
    // Land on the clip's first frame at load, not on whatever index the scene
    // file happened to store from a previous run.
    if (this.animation) this.frame = this.range?.[0] ?? 0;
  }

  _spriteTick(dt) {
    if (!this.playing) return;

    const fps = Number(this.fps);
    if (!(fps > 0)) return; // fps 0 is a legitimate "hold on this frame"

    const count = this.frameCount;
    if (!count) return; // sheet not decoded yet, or not a sheet at all

    const [from, to] = this.range ?? [0, count - 1];
    const span = to - from + 1;
    if (span <= 1) return; // a one-frame clip is a still, and never advances

    this._elapsed = (this._elapsed ?? 0) + dt;

    // Advance by whole frames and keep the remainder, rather than deriving the
    // frame from total elapsed time. That keeps a clip switched mid-play from
    // jumping to wherever the old clock happened to point, and it means a long
    // dt (a background tab, already clamped by the loop) skips frames instead of
    // dropping them.
    const step = 1 / fps;
    let advanced = 0;
    while (this._elapsed >= step) {
      this._elapsed -= step;
      advanced++;
    }
    if (!advanced) return;

    const offset = this.frame - from;
    const next = offset + advanced;

    if (next >= span && this.loop === false) {
      this.frame = to;
      this.playing = false;
      if (!this._finished) {
        this._finished = true;
        // Dispatched through the loop so an author writes `(runInfo done
        // onFinished)` like any other mode, rather than learning a sprite-only
        // convention. Same reasoning as Video's onEnded.
        this.world?.loop?.dispatchTo?.(this, 'onFinished', this);
      }
      return;
    }

    this.frame = from + (((next % span) + span) % span);
  }

  _spriteEnd() {
    this._elapsed = 0;
    this._finished = false;
  }
}

/**
 * Static def, so a Sprite animates with NO script attached.
 *
 * buildSchedule reads `constructor.agsDef`; built-ins have no compiled def, so
 * without this a bare Sprite would never tick. buildClass merges
 * `Base.agsDef.runInfo` down the chain, so a script that `(extends Sprite)`
 * inherits these and can add its own beside them.
 */
AE1Sprite.agsDef = {
  name: 'Sprite',
  extends: null,
  runInfo: {
    _spriteBegin: ['onLoad'],
    _spriteTick: ['onTick'],
    _spriteEnd: ['onUnload'],
  },
};

/**
 * Defaults for a bare Sprite.
 *
 * The SHEET is not here on purpose. Its image and frame size live in the sprite
 * component, which is the one place media already lives -- the exporter collects
 * it, dropping art onto the viewport writes it, and the Properties panel now
 * edits it. Video carries both `video` dat AND a video component and has to hedge
 * between them on every read; there is no reason to repeat that.
 */
AE1Sprite.agsDat = {
  animations: [],
  animation: '',
  fps: 12,
  playing: true,
  loop: true,
};

// Built-ins must define their own dat accessors: a bare Sprite never goes
// through the compiler, so without this its dat would sit in _props with nothing
// able to read it, and `this.fps` would be undefined on the element that owns it.
defineDatAccessors(AE1Sprite);
