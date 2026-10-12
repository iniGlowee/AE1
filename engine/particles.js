/**
 * AE1 - Particles: a particle EFFECT as an element (DESIGN.md §18.22).
 *
 * `(extends Particles)` binds one of four effect presets — flame, smoke,
 * splash, explosion — to a place in the world:
 *
 *   (fx "explosion")         ; the preset (the Properties dropdown edits the
 *                            ; fx COMPONENT's kind live; dat seeds it at load)
 *   (fxLoop false)           ; true = continuous; false = fires only on burst()
 *   (fxHost "Bazooka")       ; anchor ELEMENT (empty = this element's x/y/z)
 *   (fxNode "SocketMuzzel")  ; node/bone/socket inside the host to ride
 *   (fxOffsetX 0) …Y …Z      ; offset in the NODE's frame, world units
 *   (fxScale 1)              ; particle size multiplier
 *
 * The SIMULATION and the TEXTURES are the 3D renderer's (render3d `applyFx` +
 * canvas-generated soft radial sprites — no media files, nothing to fetch on
 * file://). This class is pure state, the Sprite split again: the element
 * says WHAT and WHERE, the renderer decides HOW it looks.
 *
 * A NON-LOOPING effect is an EVENT: `burst()` fires one emission — any script
 * can call it, and a weapon fires every non-looping effect HOSTED ON IT at
 * the projectile-spawn moment (§18.15), which is how a muzzle flash and a
 * breech smoke puff need zero code.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Particles extends AE1Element {
  _fxBegin() {
    // dat -> component: the renderer reads ONLY components, and the seeded
    // bag is what the Properties dropdown edits live during play.
    this.setComponent('fx', 'kind', String(this.fx || 'smoke'));
    this.setComponent('fx', 'loop', !(this.fxLoop === false || this.fxLoop === 'false'));
    this.setComponent('fx', 'host', String(this.fxHost || ''));
    this.setComponent('fx', 'node', String(this.fxNode || ''));
    this.setComponent('fx', 'ox', Number(this.fxOffsetX) || 0);
    this.setComponent('fx', 'oy', Number(this.fxOffsetY) || 0);
    this.setComponent('fx', 'oz', Number(this.fxOffsetZ) || 0);
    this.setComponent('fx', 'scale', Number(this.fxScale) || 1);
    // §18.52: a MEDIA image as the particle sprite (the reference game's extracted effect
    // sheets), and a tint that multiplies it — empty = the canvas presets.
    this.setComponent('fx', 'texture', String(this.fxTexture || ''));
    this.setComponent('fx', 'color', String(this.fxColor || ''));
  }

  /** Fire ONE emission now (the whole point of a non-looping effect). A
   *  monotonic counter, not a flag — two bursts in one frame both count. */
  burst() {
    this.setComponent('fx', 'burst', (Number(this.components?.fx?.burst) || 0) + 1);
    return true;
  }

  /** Change the effect live: setFx("flame"), setFx("smoke", { loop: true }). */
  setFx(kind, opts = {}) {
    if (kind) this.setComponent('fx', 'kind', String(kind));
    if ('loop' in opts) this.setComponent('fx', 'loop', opts.loop !== false);
    return true;
  }
}

AE1Particles.agsDef = {
  name: 'Particles',
  extends: null,
  runInfo: { _fxBegin: ['onLoad'] },
};

AE1Particles.agsDat = {
  fx: 'smoke',
  fxLoop: true,
  fxHost: '',
  fxNode: '',
  fxOffsetX: 0,
  fxOffsetY: 0,
  fxOffsetZ: 0,
  fxScale: 1,
  fxTexture: '',
  fxColor: '',
};

defineDatAccessors(AE1Particles);
