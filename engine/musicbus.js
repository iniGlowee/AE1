/**
 * AE1 - the background MUSIC bus (DESIGN.md §18.34).
 *
 * A third audio layer, deliberately separate from the other two:
 *
 *   - BackgroundAudioAmbience — the room's ambient bed (AE1Audio's music
 *     channel, HTMLAudio, crossfades, one per scene).
 *   - THE MUSIC BUS (this file) — area-triggered background MUSIC, driven by
 *     AudioBackgroundMusicVolume boxes, routed through WEB AUDIO so effects
 *     can touch it.
 *   - Voices & effects — one-shots, loops, and the voice registry.
 *
 * All three layers may sound at once; that is the point of the split.
 *
 * WHY WEB AUDIO IS SAFE HERE when audio.js deliberately avoids it: the graph
 * hangs off a MediaElementAudioSourceNode wrapping a plain <audio> element —
 * no fetch(), no decodeAudioData(). The element loads the file the same way
 * every other AE1 sound does (http in the editor, an inlined blob: URL in a
 * shipped export — blob is same-origin, so the source node is never tainted).
 *
 * THE FX ILLUSION (AudioFXVolume, §18.34): one source, TWO parallel branches
 * of the SAME signal —
 *
 *   <audio> → source ─┬─ dryGain ──────────────────┬─ master → speakers
 *                     └─ shaper → lowpass → wetGain ┘
 *
 * The wet branch is a REDUX-style bitcrush: a WaveShaper staircase curve
 * quantises amplitude (bit-depth reduction) and a lowpass biquad stands in
 * for the sample-rate grit — all native nodes, nothing vendored, nothing
 * touching the file itself. Walking toward an FX volume's centre crossfades
 * dry→wet EQUAL-POWER (cos/sin). Because both branches play the one live
 * signal there is NOTHING TO DE-SYNC: no second copy, no clock drift, no
 * phase inversion — the "two synced tracks" illusion with the failure modes
 * designed out. Gain moves ride setTargetAtTime, so there is no zipper noise
 * either.
 */

import { onFirstGesture } from './gesture.js';

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

export class AE1MusicBus {
  constructor(world) {
    this.world = world;
    this._ctx = null;
    this._nodes = null; // {src, audio, dry, shaper, lowpass, wet, master}
    this._key = null; // playing media key
    this._owner = null; // the music-volume element currently holding the bus
    this._fx = new Map(); // fx element -> closeness 0..1
    this._bits = 6;
    this._tone = 2400;
  }

  _ensureCtx() {
    if (this._ctx) return this._ctx;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    this._ctx = new AC();
    if (this._ctx.state === 'suspended') {
      onFirstGesture(() => this._ctx?.resume?.());
      this._ctx.resume?.().catch?.(() => {});
    }
    return this._ctx;
  }

  /** The bit-depth staircase: amplitude quantised to 2^bits steps. */
  _crushCurve(bits) {
    const steps = Math.max(2, 2 ** Math.round(bits));
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * (steps / 2)) / (steps / 2);
    }
    return curve;
  }

  _build(url) {
    const ctx = this._ensureCtx();
    if (!ctx) return null;
    this.stop(0);
    const audio = new Audio(url);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    const src = ctx.createMediaElementSource(audio);
    const dry = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._crushCurve(this._bits);
    shaper.oversample = 'none'; // the aliasing IS the aesthetic
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = this._tone;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const master = ctx.createGain();
    src.connect(dry).connect(master);
    src.connect(shaper).connect(lowpass).connect(wet).connect(master);
    master.connect(ctx.destination);
    this._nodes = { src, audio, dry, shaper, lowpass, wet, master };
    audio.play?.().catch(() => {
      onFirstGesture(() => this._nodes?.audio === audio && audio.play?.().catch(() => {}));
    });
    return this._nodes;
  }

  /**
   * An AudioBackgroundMusicVolume asking for its track. The LAST claimant
   * wins the bus (walking from one box into another hands the music over);
   * re-requesting the playing track is a no-op, never a restart.
   */
  want(el, nameOrHash, { volume = 1 } = {}) {
    const m = this.world?.resolveMedia?.(nameOrHash);
    if (!m) return;
    const key = `${m.hash}.${m.ext}`;
    this._owner = el;
    this._level = clamp01(volume);
    if (this._key === key && this._nodes) return;
    this._key = key;
    this._build(this.world.audio.url(m.hash, m.ext));
    this._apply();
  }

  /** The volume that claimed the bus no longer contains the player. */
  unwant(el) {
    if (this._owner !== el) return;
    this._owner = null;
    this._key = null;
    this.stop(600);
  }

  /** An AudioFXVolume reporting how deep the player stands in it (0..1). */
  setCrush(el, t, { bits, tone } = {}) {
    if (t <= 0) this._fx.delete(el);
    else {
      this._fx.set(el, clamp01(t));
      if (bits && bits !== this._bits && this._nodes) {
        this._bits = bits;
        this._nodes.shaper.curve = this._crushCurve(bits);
      }
      if (tone && tone !== this._tone && this._nodes) {
        this._tone = tone;
        this._nodes.lowpass.frequency.value = tone;
      }
    }
    this._apply();
  }

  /** Push levels into the graph — smoothed, equal-power, settings-aware. */
  _apply() {
    const n = this._nodes;
    if (!n) return;
    const ctx = this._ctx;
    const audioSys = this.world?.audio;
    const setting = audioSys ? (audioSys.muted ? 0 : clamp01(audioSys.musicVolume)) : 1;
    let mix = 0;
    for (const t of this._fx.values()) mix = Math.max(mix, t);
    const T = 0.08; // seconds; fast but zipper-free
    n.master.gain.setTargetAtTime(setting * (this._level ?? 1), ctx.currentTime, T);
    n.dry.gain.setTargetAtTime(Math.cos((mix * Math.PI) / 2), ctx.currentTime, T);
    n.wet.gain.setTargetAtTime(Math.sin((mix * Math.PI) / 2), ctx.currentTime, T);
  }

  stop(fadeMs = 300) {
    const n = this._nodes;
    if (!n) return;
    this._nodes = null;
    if (fadeMs && this._ctx) {
      n.master.gain.setTargetAtTime(0, this._ctx.currentTime, fadeMs / 3000);
      setTimeout(() => {
        n.audio.pause();
        n.audio.src = '';
        n.src.disconnect();
        n.master.disconnect();
      }, fadeMs + 120);
    } else {
      n.audio.pause();
      n.audio.src = '';
      n.src.disconnect();
      n.master.disconnect();
    }
  }

  /**
   * A scene change kills the bus (§18.36): the claiming music box and every
   * FX box belonged to the OUTGOING scene — with their ticks gone, nothing
   * would ever release the track or zero the crush, and the bitcrushed
   * ghost followed the player through the door. The new scene's boxes
   * re-claim within a tick if the player stands in one.
   */
  sceneChange() {
    this._fx.clear();
    this._owner = null;
    this._key = null;
    this.stop(400);
  }

  /** World teardown (Stop in the editor, page unload). */
  dispose() {
    this.stop(0);
    this._fx.clear();
    this._owner = null;
    this._key = null;
  }
}
