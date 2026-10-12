/**
 * AE1 - Ambience: the scene's background music as an ELEMENT (DESIGN.md §18.19).
 *
 * `(extends Ambience)` + `(music "backgroundAudio.mp3")` — the track starts
 * with the scene, LOOPS, and survives everything the sound-effect channel
 * does: dialogue lines, weapon fire, and every other one-shot play beside it,
 * never over it (AE1Audio's music/sounds split, §8.1). The Skybox pattern,
 * for the ears: one element owns one environmental axis, dat-driven, no code.
 *
 *   (music "file.mp3")   ; the looping track; empty = silence
 *   (musicFade 400)      ; crossfade milliseconds on start and swap
 *
 * SCENE-LEVEL ACCESS is the standard library, not this class: ANY element's
 * script may `this.stopMusic()` (a scripted event killing the theme) or
 * `this.playMusic("other.mp3")` (a swap) — the channel is the world's.
 * `setMusic("file")` here is the polite front door: it swaps with this
 * element's configured fade, and `setMusic("")` stops. Re-requesting the
 * SAME track is a no-op by AE1Audio's contract, so a scene reload never
 * stutters the theme.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Ambience extends AE1Element {
  _ambBegin() {
    if (this.music) this.playMusic(String(this.music), { fade: Number(this.musicFade) || 400 });
  }

  /** Swap the track (with this element's fade); empty name = stop. */
  setMusic(name, opts = {}) {
    if (!name) {
      this.stopMusic();
      return null;
    }
    return this.playMusic(String(name), { fade: Number(this.musicFade) || 400, ...opts });
  }
}

// Renamed (§18.34): this class is the AMBIENT BED layer — one of three
// deliberate audio layers (ambience / the music bus / voices & effects) that
// may all sound at once. 'Ambience' stays as a legacy alias in BUILTINS.
AE1Ambience.agsDef = {
  name: 'BackgroundAudioAmbience',
  extends: null,
  runInfo: { _ambBegin: ['onLoad'] },
};

AE1Ambience.agsDat = {
  music: '',
  musicFade: 400,
};

defineDatAccessors(AE1Ambience);
