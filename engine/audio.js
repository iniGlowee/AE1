/**
 * AE1 - audio.
 *
 * Music is one channel that crossfades; sound effects are fire-and-forget and may
 * overlap. That split is the genre's whole audio model: a room has a theme, and
 * things in it make noises.
 *
 * HTMLAudioElement, not WebAudio. WebAudio would buy mixing and effects we do not
 * need yet, and needs decodeAudioData -- which means fetch(), which is blocked on
 * file://. An <audio> tag with a relative src works from a double-clicked page
 * (DESIGN.md §8.1). Revisit if real mixing is ever needed.
 */

import { onFirstGesture, hasGestured } from './gesture.js';

export class AE1Audio {
  /**
   * @param {string} mediaBase  URL prefix: `${base}/${hash}.${ext}`
   */
  constructor(mediaBase) {
    this.mediaBase = mediaBase;
    this.muted = false;
    this.musicVolume = 0.6;
    this.soundVolume = 1;

    /**
     * Per-AREA loudness, 0..1, multiplied onto musicVolume.
     *
     * A second axis from the player's volume setting, and a different thing: the
     * setting is "how loud do I like my games", the scene level is "this room is
     * quieter than that one". A tour that is hushed in the bedroom and loud at the
     * desk needs to vary loudness WITHOUT touching the player's preference — so
     * effective volume is the product of the two, and setSceneLevel fades the
     * playing track to the new product without disturbing the setting.
     */
    this.sceneLevel = 1;

    /** @type {HTMLAudioElement|null} */
    this._music = null;
    this._musicKey = null;

    /** Live one-shots, so stopAll() can actually stop them all. */
    this._sounds = new Set();

    /** A music intent the browser refused; retried on the first gesture. */
    this._cancelPending = null;
  }

  url(hash, ext) {
    return `${this.mediaBase}/${hash}.${ext}`;
  }

  /* -- music ------------------------------------------------------------- */

  /** What the music track should actually be at right now: setting × area, or 0 muted. */
  _musicTarget() {
    return this.muted ? 0 : clampVol(this.musicVolume) * clampVol(this.sceneLevel);
  }

  /**
   * Play looping music. Re-requesting the SAME track is a no-op, not a restart:
   * an onLoad that starts the room's theme must not stutter it every time the
   * player re-enters the room. That no-op is what lets every scene in a tour call
   * playMusic on load to keep one continuous track alive across scene changes.
   *
   * `volume`, if given, is a fixed override for this track; omit it and the track
   * follows the player setting × the per-area sceneLevel (the usual case).
   */
  playMusic(hash, ext, { volume = null, loop = true, fade = 400 } = {}) {
    const key = `${hash}.${ext}`;
    if (this._musicKey === key && this._music && !this._music.paused) return this._music;

    this.stopMusic(fade);

    const audio = new Audio(this.url(hash, ext));
    audio.loop = loop;
    audio.volume = 0;
    this._music = audio;
    this._musicKey = key;

    audio.play?.().catch(() => {
      // Autoplay refused. Remember what was wanted; the first gesture starts it.
      if (hasGestured()) return;
      this._cancelPending?.();
      this._cancelPending = onFirstGesture(() => {
        this._cancelPending = null;
        // Only if nothing else has claimed the channel since.
        if (this._musicKey === key) this.playMusic(hash, ext, { volume, loop, fade });
      });
    });

    const target = volume == null ? this._musicTarget() : (this.muted ? 0 : clampVol(volume));
    this._fade(audio, target, fade);
    return audio;
  }

  /**
   * Fade the current track to a new per-area loudness, and remember it for later
   * tracks. Does nothing audible if no music is playing — the level still sticks,
   * so the next track that starts respects it.
   */
  setSceneLevel(level, { fade = 600 } = {}) {
    this.sceneLevel = clampVol(level);
    if (this._music) this._fade(this._music, this._musicTarget(), fade);
    return this.sceneLevel;
  }

  stopMusic(fade = 300) {
    const audio = this._music;
    if (!audio) return;
    this._music = null;
    this._musicKey = null;
    this._fade(audio, 0, fade, () => {
      audio.pause();
      audio.src = ''; // release the decoder, not just the reference
    });
  }

  _fade(audio, to, ms, done) {
    if (!ms) {
      audio.volume = to;
      done?.();
      return;
    }

    const from = audio.volume;
    const start = performance.now();

    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      audio.volume = Math.max(0, Math.min(1, from + (to - from) * t));
      if (t < 1) requestAnimationFrame(step);
      else done?.();
    };
    requestAnimationFrame(step);
  }

  /* -- sounds ------------------------------------------------------------- */

  /**
   * Fire a one-shot. Overlapping calls layer rather than cut each other off --
   * clicking a character twice quickly should sound like two clicks.
   */
  play(hash, ext, { volume = this.soundVolume, rate = 1 } = {}) {
    const audio = new Audio(this.url(hash, ext));
    audio.volume = this.muted ? 0 : volume;
    audio.playbackRate = rate;

    this._sounds.add(audio);
    const done = () => {
      this._sounds.delete(audio);
      audio.src = '';
    };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });

    // A blocked one-shot is not worth queueing: by the time the player interacts,
    // the moment it belonged to has passed.
    audio.play?.().catch(() => done());

    return audio;
  }

  /**
   * A LOOPING effect with a handle — footsteps, an engine hum, rain. Not
   * music (that channel crossfades and is exclusive) and not a one-shot
   * (these never end on their own): the CALLER owns the lifetime and stops
   * it with `handle.stopLoop()`, which also releases the decoder. Overlaps
   * are allowed — two characters may each loop their own steps.
   */
  loop(hash, ext, { volume = this.soundVolume, rate = 1 } = {}) {
    const audio = new Audio(this.url(hash, ext));
    audio.loop = true;
    audio.volume = this.muted ? 0 : clampVol(volume);
    audio.playbackRate = rate;
    this._sounds.add(audio);
    audio.play?.().catch(() => {}); // blocked? stays silent; the gate is muted/gesture
    audio.stopLoop = () => {
      this._sounds.delete(audio);
      audio.pause();
      audio.src = ''; // release the decoder, not just the reference
    };
    return audio;
  }

  stopAll() {
    for (const audio of this._sounds) {
      audio.pause();
      audio.src = '';
    }
    this._sounds.clear();
    this.stopMusic(0);
    this._cancelPending?.();
    this._cancelPending = null;
  }

  setMuted(muted) {
    this.muted = muted;
    // The music target already folds in muted and the per-area level; sounds are
    // one-shots with no area dimension, so they just gate on muted.
    if (this._music) this._music.volume = this._musicTarget();
    for (const audio of this._sounds) audio.volume = muted ? 0 : clampVol(this.soundVolume);
  }
}

const clampVol = (n) => Math.max(0, Math.min(1, Number(n) || 0));
