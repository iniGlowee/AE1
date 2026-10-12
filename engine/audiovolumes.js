/**
 * AE1 - audio VOLUMES (DESIGN.md §18.34): rectangular regions a developer
 * drops into a scene and shapes with the ordinary transform tools — x/y/z is
 * the centre, scaleX/Y/Z the size in metres, rotationY the yaw. The renderer
 * draws each one as a lightly translucent box (teal = music, magenta = FX) so
 * they read in the viewport; uncheck `visible` to hide them (they keep
 * working — the box is authoring ink, not the mechanism).
 *
 * `(extends AudioBackgroundMusicVolume)` — while the PLAYER stands inside,
 * this box's `(music "file.mp3")` plays on the world's MUSIC BUS (musicbus.js;
 * Web Audio, loop). Walking out fades it away; walking from one box into
 * another hands the bus over. This layer is deliberately separate from
 * BackgroundAudioAmbience (the scene's ambient bed) and from voices/effects —
 * all three may sound at once.
 *
 * `(extends AudioFXVolume)` — touches whatever the music bus is playing:
 * approaching the box's CENTRE crossfades the live track into its REDUX
 * (bitcrushed) twin — same signal, two branches, equal-power, so there is no
 * copy to drift and no phase to invert (the illusion architecture lives in
 * musicbus.js). `(bits 6)` sets the crunch, `(crushTone 2400)` the lowpass.
 *
 * Both classes are pure logic + a `volume` component for the renderer's box —
 * no three.js here, per the architecture split.
 */

import { AE1Element, defineDatAccessors } from './element.js';
import { AE1ThirdPersonCharacter } from './thirdperson.js';

const DEG = Math.PI / 180;

class AE1AudioVolumeBase extends AE1Element {
  /** The player, cached per scene life. */
  _volPlayer() {
    if (this._vp === undefined) {
      this._vp = this.world?.scene?.all().find((e) => e instanceof AE1ThirdPersonCharacter) ?? null;
    }
    return this._vp;
  }

  /**
   * How deep the player stands inside this box: 1 at the centre, 0 at the
   * faces, null outside. Chest height, yaw-aware, sizes from scale.
   */
  _closeness() {
    const p = this._volPlayer();
    if (!p) return null;
    const hx = Math.abs(this.scaleX ?? 1) / 2;
    const hy = Math.abs(this.scaleY ?? 1) / 2;
    const hz = Math.abs(this.scaleZ ?? 1) / 2;
    if (!hx || !hy || !hz) return null;
    const dx = (p.x ?? 0) - (this.x ?? 0);
    const dy = (p.y ?? 0) + 1 - (this.y ?? 0);
    const dz = (p.z ?? 0) - (this.z ?? 0);
    const yaw = -(this.rotationY ?? 0) * DEG;
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const edge = Math.max(Math.abs(lx) / hx, Math.abs(dy) / hy, Math.abs(lz) / hz);
    return edge <= 1 ? 1 - edge : null;
  }
}

export class AE1AudioBackgroundMusicVolume extends AE1AudioVolumeBase {
  _bgmBegin() {
    this.setComponent?.('volume', 'kind', 'music');
  }

  _bgmTick() {
    const bus = this.world?.musicBus;
    if (!bus || !this.music) return;
    const t = this._closeness();
    if (t != null) bus.want(this, this.music, { volume: Number(this.musicVolume ?? 1) });
    else bus.unwant(this);
  }
}

AE1AudioBackgroundMusicVolume.agsDef = {
  name: 'AudioBackgroundMusicVolume',
  extends: null,
  runInfo: { _bgmBegin: ['onLoad'], _bgmTick: ['onTick'] },
};

AE1AudioBackgroundMusicVolume.agsDat = {
  music: '',
  musicVolume: 1,
};

defineDatAccessors(AE1AudioBackgroundMusicVolume);

export class AE1AudioFXVolume extends AE1AudioVolumeBase {
  _fxvBegin() {
    this.setComponent?.('volume', 'kind', 'fx');
  }

  _fxvTick() {
    const bus = this.world?.musicBus;
    if (!bus) return;
    const t = this._closeness();
    bus.setCrush(this, t ?? 0, {
      bits: Number(this.bits) || 0,
      tone: Number(this.crushTone) || 0,
    });
  }
}

AE1AudioFXVolume.agsDef = {
  name: 'AudioFXVolume',
  extends: null,
  runInfo: { _fxvBegin: ['onLoad'], _fxvTick: ['onTick'] },
};

AE1AudioFXVolume.agsDat = {
  bits: 6,
  crushTone: 2400,
};

defineDatAccessors(AE1AudioFXVolume);
