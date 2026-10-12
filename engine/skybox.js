/**
 * AE1 - Skybox: the sky as an element (DESIGN.md §18.13).
 *
 * `(extends Skybox)` puts an equirect .hdr from the Media Collection around
 * the whole scene — background AND, with `(lightScene true)`, the image-based
 * lighting, so a night sky makes the world night. The element carries a `sky`
 * component the renderer reads; this class only writes it. dat:
 *
 *   (sky "PSX_NIGHTSKY.hdr")   ; the .hdr media name
 *   (skyOpacity 1)             ; 0..1 — dims toward black
 *   (skyRotation 0)            ; degrees around the vertical
 *   (skySpin 0)                ; degrees/second, a slowly turning sky
 *   (lightScene true)          ; the sky is also the scene's light
 *
 * The grip numbers are read LIVE while displayed (the mount pattern): tune
 * skyOpacity/skyRotation in Properties during play and the sky follows.
 * Scripts drive it the same way any element does:
 *
 *   this.find("Skybox").setSky("dawn.hdr");
 *   this.find("Skybox").skyRotation = 90;
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Skybox extends AE1Element {
  /** Swap the sky to another .hdr by media name ('' clears it). */
  setSky(name) {
    return this.setComponent('sky', 'media', String(name ?? ''));
  }

  _skyBegin() {
    // dat -> component, so the renderer needs no knowledge of dat.
    this.setComponent('sky', 'media', String(this.sky ?? ''));
  }

  _skyTick(dt) {
    const spin = Number(this.skySpin) || 0;
    if (spin) this.skyRotation = ((Number(this.skyRotation) || 0) + spin * dt) % 360;
  }
}

AE1Skybox.agsDef = {
  name: 'Skybox',
  extends: null,
  runInfo: { _skyBegin: ['onLoad'], _skyTick: ['onTick'] },
};

AE1Skybox.agsDat = {
  sky: '',
  skyOpacity: 1,
  skyRotation: 0,
  skySpin: 0,
  lightScene: true,
  // §18.57: how strongly the sky lights PBR materials (reflections
  // included), separate from backdrop brightness. 1 = full (default);
  // ~0.3 tames metallic floors that mirror the HDRI into blue glass.
  envIntensity: 1,
};

defineDatAccessors(AE1Skybox);
