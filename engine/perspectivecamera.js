/**
 * AE1 - PerspectiveCamera (DESIGN.md §18.30).
 *
 * `(extends PerspectiveCamera)` makes an element an INVISIBLE EYE: it renders
 * nothing itself, but every frame the 3D renderer draws the scene from this
 * element's position — along its aim normal — into a private render target,
 * and any surface that wants "a live view from over there" samples that
 * texture. Portals are the first tenant (each oval face shows the OTHER
 * portal's eye), security monitors and mirrors are the obvious next ones.
 *
 *   (fov 60)          ; vertical field of view, degrees
 *   (near 0.05)       ; clip planes, metres
 *   (far 200)
 *   (aspect 1)        ; width/height the SURFACE will display — pre-squash
 *   (captureSize 512) ; render-target resolution (square)
 *
 * The element's x/y/z is the eye. The aim is a world-space NORMAL in the
 * `camera` component (`nx, ny, nz`) — `aimAlong(nx, ny, nz)` sets it, the
 * portal gun calls it with the wall's surface normal. All of it is live: move
 * the element, retune the fov, the capture follows next frame.
 *
 * Like Skybox and Particles, the class is a thin dat→component bridge — the
 * actual camera, target, and per-frame render live in render3d (`applyCapture`
 * / `renderCaptures`), keyed by this element's `camera` component.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1PerspectiveCamera extends AE1Element {
  _pcamBegin() {
    const c = this.components?.camera ?? {};
    this.setComponent?.('camera', 'fov', Number(this.fov) || 60);
    this.setComponent?.('camera', 'near', Number(this.near) || 0.05);
    this.setComponent?.('camera', 'far', Number(this.far) || 200);
    this.setComponent?.('camera', 'aspect', Number(this.aspect) || 1);
    this.setComponent?.('camera', 'size', Number(this.captureSize) || 512);
    // Keep an existing aim (a reloaded scene remembers); default +z.
    if (c.nx == null && c.ny == null && c.nz == null) this.aimAlong(0, 0, 1);
  }

  /** Point the eye along a world-space direction (unnormalised is fine). */
  aimAlong(nx, ny, nz) {
    const len = Math.hypot(nx, ny, nz) || 1;
    this.setComponent?.('camera', 'nx', nx / len);
    this.setComponent?.('camera', 'ny', ny / len);
    this.setComponent?.('camera', 'nz', nz / len);
  }
}

AE1PerspectiveCamera.agsDef = {
  name: 'PerspectiveCamera',
  extends: null,
  runInfo: { _pcamBegin: ['onLoad'] },
};

AE1PerspectiveCamera.agsDat = {
  fov: 60,
  near: 0.05,
  far: 200,
  aspect: 1,
  captureSize: 512,
};

defineDatAccessors(AE1PerspectiveCamera);
