/**
 * AE1 — ClickMarker: a world-anchored cursor that shows WHERE the player clicked.
 *
 * The classic point-and-click tell: click the ground and a marker blooms on that
 * spot (the reference MMO's spinning yellow X), then fades — so the player can see the
 * target they just picked even before their character arrives. Drop-in and
 * genre-neutral: `(extends ClickMarker)` in any project that uses cursor-mode
 * clicking. The marker is a DOM image pinned to the clicked GROUND point via
 * env3d.worldToScreen every frame, so it stays on that spot as the camera orbits.
 *
 * The image is customizable from Angel Script — `(image "cursor.png")` names a
 * media file, or pass a URL / data-URI directly; omitted, a built-in yellow X is
 * used. `size`, `duration`, and `spin` tune the look.
 */
import { AE1Element, defineDatAccessors } from './element.js';

// Built-in default: a reference MMO-style four-point yellow star/X, red-edged.
const DEFAULT_MARK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<path d="M16 2 L20 12 L30 16 L20 20 L16 30 L12 20 L2 16 L12 12 Z" ' +
      'fill="#ffe020" stroke="#b02000" stroke-width="1.5" stroke-linejoin="round"/>' +
      '</svg>',
  );

export class AE1ClickMarker extends AE1Element {
  _cmBegin() {
    const input = this.world?.input3d;
    if (this.cursor !== false && input) input.cursorMode = true;

    this._mark = null; // { x, y, z, t } active marker in WORLD space
    this._src = this._resolveImage();

    if (typeof document === 'undefined') return;
    const img = document.createElement('img');
    img.src = this._src;
    img.draggable = false;
    img.style.cssText =
      'position:fixed;z-index:99997;display:none;pointer-events:none;' +
      'transform-origin:center;image-rendering:auto;will-change:transform,opacity;';
    document.body.appendChild(img);
    this._img = img;
    this._ensureListener(); // canvas may not be attached yet — retried each tick
  }

  /** Attach our OWN canvas listener (idempotent) — independent of the mover's
   *  click drain, so both react to the same physical click with no consumer
   *  conflict. The input canvas isn't attached until Play's enterPlay(), which
   *  can run AFTER onLoad, so the first ticks retry until it exists. */
  _ensureListener() {
    if (this._onDown) return true;
    const input = this.world?.input3d;
    const canvas = input?.canvas;
    if (!canvas) return false;
    this._canvas = canvas;
    this._onDown = (e) => {
      if (e.button !== 0) return;                   // left-click marks
      if (this.cursor !== false && input && !input.cursorMode) return;
      const r = canvas.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const g = this.world?.env3d?.pointerGround?.(nx, ny);
      if (g) this._mark = { x: g.x, y: g.y, z: g.z, t: 0 };
    };
    canvas.addEventListener('mousedown', this._onDown);
    return true;
  }

  _resolveImage() {
    const v = this.image;
    if (!v || typeof v !== 'string') return DEFAULT_MARK;
    if (/^(https?:|data:|\/)/.test(v)) return v;    // URL / data-URI / absolute path
    const m = this.world?.resolveMedia?.(v);         // else a project media name
    if (m) return `${this.world.mediaBase ?? 'media'}/${m.hash}.${m.ext}`;
    return v;
  }

  _cmTick(dt) {
    const img = this._img;
    if (!img) return;
    if (!this._onDown) this._ensureListener(); // attach once the canvas exists
    if (!this._mark) { if (img.style.display !== 'none') img.style.display = 'none'; return; }

    const dur = Math.max(0.05, Number(this.duration) || 0.6);
    this._mark.t += dt;
    const k = this._mark.t / dur;                    // 0 → 1 progress
    if (k >= 1) { this._mark = null; img.style.display = 'none'; return; }

    const s = this.world?.env3d?.worldToScreen?.(this._mark.x, this._mark.y, this._mark.z);
    if (!s || s.behind) { img.style.display = 'none'; return; }

    const size = Math.max(4, Number(this.size) || 32);
    const scale = 1.3 - 0.5 * k;                     // blooms then settles
    const spin = this.spin === false ? 0 : k * 180;  // half-turn over its life
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.left = `${s.x - size / 2}px`;
    img.style.top = `${s.y - size / 2}px`;
    img.style.opacity = String(1 - k * k);           // fade out, ease-in
    img.style.transform = `scale(${scale}) rotate(${spin}deg)`;
    img.style.display = 'block';
  }

  onRemove() {
    if (typeof document !== 'undefined') {
      if (this._canvas && this._onDown) this._canvas.removeEventListener('mousedown', this._onDown);
      this._img?.remove();
    }
    super.onRemove?.();
  }
}

AE1ClickMarker.agsDef = {
  name: 'ClickMarker',
  extends: 'Element',
  runInfo: { _cmBegin: ['onLoad'], _cmTick: ['onTick'] },
};

AE1ClickMarker.agsDat = {
  ...AE1Element.agsDat,
  image: '',        // media name, URL, or data-URI; empty ⇒ built-in yellow X
  size: 32,         // marker size in CSS pixels
  duration: 0.6,    // seconds it stays before fading out
  spin: true,       // rotate as it fades (the reference MMO's click-X spin)
  cursor: true,     // ensure point-and-click cursor mode on load
};

defineDatAccessors(AE1ClickMarker);
