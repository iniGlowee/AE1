/**
 * AE1 - Passive proximity dialogue (DESIGN.md §18.18).
 *
 * `(extends PassiveDialogue)` on a character element gives it AMBIENT VOICE:
 * stand NEAR its Hitbox volume — `senseRange` beyond it, sensing, not
 * touching — and it MAY speak one of its `passiveLines`. Or not: silence is
 * part of the design (`passiveChance`), and so is the pause between attempts
 * (`passiveCooldown`). No interaction, no state to manage — the player just
 * overhears an idling character. Scripted (non-passive) conversation remains
 * the DialogueDelegate's job; this class never touches it.
 *
 *   (passiveLines ("a.mp3" "b.mp3"))  ; the pool; one is picked at random,
 *                                     ; never the same line twice running
 *   (senseRange 3)      ; metres beyond the volume that count as "near"
 *   (hearRange 12)      ; where the voice fades to nothing with distance
 *   (passiveChance 0.6) ; odds a trigger speaks at all — the rest is silence
 *   (passiveCooldown 8) ; seconds between attempts while lingering
 *   (passiveVolume 1)   ; base loudness, before the distance falloff
 *
 * VOICES ARE TAGGED: every line plays through `emitVoice`, which registers
 * {el, audio, base} in `world.voices` — so any system can ask "who is
 * speaking, from where" and compare elements by proximity. Two rules ride on
 * the registry: only ONE voice world-wide (a second speaker waits for the
 * next roll — organic, no queue), and the emitter attenuates its own line
 * LIVE by the listener's distance (closer is louder; past `hearRange`,
 * silent). The audio element is dropped from the registry AND released the
 * moment it ends — playSound's own ended/error cleanup does the disposal,
 * this module only ever holds the tag.
 */

import { defineDatAccessors } from './element.js';
import { AE1Hitbox } from './hitbox.js';
import { AE1ThirdPersonCharacter } from './thirdperson.js';

/**
 * Play a line FROM an element, tagged. Now a thin alias for the element
 * std-lib `voiceLine` (§18.29) — which also enforces ONE VOICE PER ELEMENT
 * (a new line cuts the same element's previous one; the goober was growling
 * under his own death cry). Null if the world has no audio (the editor's
 * partial world; absent means no-op, never a throw).
 */
export function emitVoice(el, name, opts = {}) {
  return el.voiceLine?.(name, opts) ?? null;
}

/** Is any tagged voice still speaking? (Two lines must never overlap.) */
export function voiceBusy(world) {
  for (const v of world?.voices ?? []) {
    if (!v.audio.ended && v.audio.src) return true;
    world.voices.delete(v); // a finished voice found here missed its drop
  }
  return false;
}

export class AE1PassiveDialogue extends AE1Hitbox {
  /** The line pool, reader-collapse normalised (one line arrives as a bare
   *  string — the same trap as animLibs). */
  _pvLines() {
    const v = this.passiveLines;
    if (typeof v === 'string') return v ? [v] : [];
    return Array.isArray(v) ? v.map(String) : [];
  }

  _pvTick(dt) {
    if (this.visible === false || this._dead) return;
    const lines = this._pvLines();
    if (!lines.length) return;

    // The listener is THE third-person character (the scene singleton).
    if (this._pvPlayer === undefined) {
      this._pvPlayer =
        this.world?.scene?.all().find((e) => e instanceof AE1ThirdPersonCharacter) ?? null;
    }
    const p = this._pvPlayer;
    if (!p) return;

    // -- my live line follows the listener (closer = louder) --------------- //
    if (this._pvVoice) {
      const a = this._pvVoice.audio;
      if (a.ended || !a.src) this._pvVoice = null;
      else {
        const d = Math.hypot((p.x ?? 0) - (this.x ?? 0), (p.z ?? 0) - (this.z ?? 0));
        const hear = Math.max(1, Number(this.hearRange) || 12);
        const fall = Math.max(0, Math.min(1, 1 - d / hear));
        a.volume = this.world?.audio?.muted ? 0 : this._pvVoice.base * fall;
      }
    }

    // -- sensing: near is the VOLUME plus senseRange, not a touch ----------- //
    const near = this.containsPoint(p.x ?? 0, p.y ?? 0, p.z ?? 0, Number(this.senseRange) || 3);
    // The cooldown runs whether they stay or go: dancing on the boundary
    // cannot spam him, and coming back after a while rolls straight away.
    this._pvT = Math.max(0, (this._pvT ?? 0) - dt);
    if (!near || this._pvT > 0) return;
    this._pvT = Math.max(1, Number(this.passiveCooldown) || 8);

    // -- the roll: sometimes he simply says nothing ------------------------- //
    const chance = Math.max(0, Math.min(1, Number(this.passiveChance ?? 0.6)));
    if (Math.random() >= chance) return;
    if (voiceBusy(this.world)) return; // someone is talking — let them finish

    let pick = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && pick === this._pvLast) {
      pick = lines[(lines.indexOf(pick) + 1) % lines.length];
    }
    this._pvLast = pick;
    const volume = Math.max(0, Math.min(1, Number(this.passiveVolume ?? 1)));
    this._pvVoice = emitVoice(this, pick, { volume });
    if (this._pvVoice) this.world?.loop?.dispatchTo(this, 'onSpeak', pick);
  }
}

AE1PassiveDialogue.agsDef = {
  name: 'PassiveDialogue',
  extends: null,
  runInfo: { _pvTick: ['onTick'] },
};

AE1PassiveDialogue.agsDat = {
  ...AE1Hitbox.agsDat,
  pickable: false, // a speaking character is listened to, not pocketed
  hasPhysics: false,
  passiveLines: [],
  senseRange: 3,
  hearRange: 12,
  passiveChance: 0.6,
  passiveCooldown: 8,
  passiveVolume: 1,
};

defineDatAccessors(AE1PassiveDialogue);
